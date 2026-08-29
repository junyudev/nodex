use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};
use std::path::Path;

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::ModuleName;
use nodex_core_contracts::library::{
    LibraryBlockTransferDocumentCommit, LibraryEditorResumeEdge, LibraryEditorResumeTarget,
    LibraryStructuralClipboardToken, LibraryStructuralDeleteDirection,
    LibraryStructuralDeleteReason, LibraryStructuralEditCommand, LibraryStructuralEditResult,
    LibraryStructuralHistoryToken, LibraryStructuralReplacement, LibraryStructuralReplacementBlock,
    LibraryStructuralSelection, LibraryStructuralTarget, LibraryStructuralTurnIntoTarget,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::document::{
    CanvasScene, DocumentBlockOperation, DocumentBlockUpdatePatch, DocumentPlacementEvidence,
    PersistYjsGenesis, clone_canvas_scene_genesis, current_schema_for_stored_identity,
    load_canvas_scene, normalize_stored_materialized_forest, persist_yjs_genesis_with_local_commit,
    prepare_yjs_clone_genesis, read_document_authority, schema_metadata, sha256,
};
use crate::domain::block_materialization::MaterializedBlockNode;
use crate::domain::identity::stable_uuid_v7;
use crate::domain::ordinary_block::{
    canonical_equation_block_content, canonical_ordinary_block_shape,
};
use crate::domain::page_to_block::{PageToBlockTransformation, plan_page_to_block_transformation};
use crate::domain::rich_text::RichTextItem;
use crate::infrastructure::durable_mutation::{self, OperationIdentity};
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

use super::LibraryApplyOutcome;
use super::mutation::{
    MutationEffects, ParentDocumentPlacement, ParentDocumentWriteContext, ResolvedParentDocument,
    ensure_default_page_intrinsic_properties, insert_page_read_model, library_commit_result,
    load_parent_document, persist_parent_operations_detailed_with_local_commit,
    persist_parent_relocation_source_with_local_commit,
    persist_parent_relocation_source_with_placeholder, refresh_page_intrinsic_projection,
    require_project_in_library, seal_mutation_with, sqlite_now,
};
use super::page_file_ownership_move::{
    PageFileOwnershipMoveEffects, PageFilePlacementMove, candidate_file_ids,
    move_exclusively_placed_files,
};

const SNAPSHOT_VERSION: u32 = 2;
const RECIPE_VERSION: u32 = 3;
const MAX_STRUCTURAL_ROOTS: usize = 10_000;
const MAX_STRUCTURAL_BLOCKS: usize = 10_000;
const MAX_STRUCTURAL_DEPTH: usize = 128;
const MAX_STRUCTURAL_DOCUMENTS: usize = 1_024;
const TYPED_OWNER_TYPES: &[&str] = &[
    "page",
    "canvas",
    "database",
    "synced_block_source",
    "reusable_template_source",
];

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RootPlacement {
    block_id: String,
    parent_block_id: Option<String>,
    before_block_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StructuralLocation {
    document_id: String,
    document_generation: i64,
    host_page_id: String,
    placements: Vec<RootPlacement>,
    placeholder_block_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BlockAuthoritySnapshot {
    block_id: String,
    block_type: String,
    lifecycle: String,
    metadata_revision: i64,
    placement_revision: i64,
    containing_document_id: String,
    in_host_document: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BlockPropertySnapshot {
    property_key: String,
    value_type: String,
    value_json: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageAuthoritySnapshot {
    block_id: String,
    document_id: String,
    parent_kind: String,
    parent_id: String,
    properties: Vec<BlockPropertySnapshot>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DatabaseSourceSnapshot {
    source_id: String,
    name: String,
    schema_key: String,
    schema_revision: i64,
    rank_key: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DatabasePropertySnapshot {
    source_id: String,
    property_id: String,
    name: String,
    value_type: String,
    config_json: String,
    rank_key: String,
    lifecycle: String,
    schema_revision: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DatabaseRelationPropertySnapshot {
    source_id: String,
    property_id: String,
    target_source_id: String,
    cardinality: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DatabasePropertyValueSnapshot {
    property_id: String,
    value_type: String,
    value_json: String,
    revision: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DatabaseViewPositionSnapshot {
    view_id: String,
    rank_key: String,
    revision: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DatabaseRelationEdgeSnapshot {
    edge_id: String,
    property_id: String,
    target_page_id: String,
    sibling_rank: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DatabaseRowSnapshot {
    membership_id: String,
    source_id: String,
    page_id: String,
    revision: i64,
    completed_at: Option<String>,
    projected_view_id: Option<String>,
    view_group_key: Option<String>,
    view_rank_key: Option<String>,
    database_values_json: String,
    property_values: Vec<DatabasePropertyValueSnapshot>,
    view_positions: Vec<DatabaseViewPositionSnapshot>,
    relation_edges: Vec<DatabaseRelationEdgeSnapshot>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DatabaseViewSnapshot {
    view_id: String,
    source_id: String,
    name: String,
    default_layout: String,
    config_json: String,
    revision: i64,
    rank_key: String,
    lifecycle: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DatabaseAuthoritySnapshot {
    block_id: String,
    name: String,
    lifecycle: String,
    default_view_id: Option<String>,
    access_revision: i64,
    metadata_revision: i64,
    sources: Vec<DatabaseSourceSnapshot>,
    properties: Vec<DatabasePropertySnapshot>,
    relation_properties: Vec<DatabaseRelationPropertySnapshot>,
    views: Vec<DatabaseViewSnapshot>,
    rows: Vec<DatabaseRowSnapshot>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum OwnedDocumentBody {
    Yjs {
        rich_title: Vec<RichTextItem>,
        blocks: Vec<MaterializedBlockNode>,
    },
    Canvas {
        scene: CanvasScene,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnedDocumentSnapshot {
    owner_block_id: String,
    owner_type: String,
    document_id: String,
    containing_document_id: String,
    schema_key: String,
    schema_version: i64,
    generation: i64,
    head_seq: i64,
    body: OwnedDocumentBody,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnershipClosureSnapshot {
    version: u32,
    roots: Vec<MaterializedBlockNode>,
    blocks: Vec<BlockAuthoritySnapshot>,
    documents: Vec<OwnedDocumentSnapshot>,
    pages: Vec<PageAuthoritySnapshot>,
    databases: Vec<DatabaseAuthoritySnapshot>,
    #[serde(default)]
    host_page_file_ids: Vec<String>,
    source: StructuralLocation,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DormantPageState {
    page_id: String,
    document_id: String,
    generation: i64,
    head_seq: i64,
    placeholder_block_id: String,
    moved_root_ids: Vec<String>,
    moved_block_ids: Vec<String>,
    revoked_grant_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TurnedSelectionState {
    original: OwnershipClosureSnapshot,
    active: OwnershipClosureSnapshot,
    target: LibraryStructuralTurnIntoTarget,
    dormant_pages: Vec<DormantPageState>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackwardMergeState {
    /// The pre-merge Block tree and placement, with authority revisions
    /// refreshed to the state expected by the next history transition.
    snapshot: OwnershipClosureSnapshot,
    target_block_id: String,
    source_block_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum StructuralRecipeAction {
    WithInlineContent {
        action: Box<StructuralRecipeAction>,
        host_page_id: String,
        host_document_id: String,
        block_id: String,
        expected_content: serde_json::Value,
        replacement_content: serde_json::Value,
    },
    RestoreDeleted {
        snapshot: OwnershipClosureSnapshot,
        target: StructuralLocation,
        deletion_direction: LibraryStructuralDeleteDirection,
    },
    DeleteActive {
        snapshot: OwnershipClosureSnapshot,
        source: StructuralLocation,
        direction: LibraryStructuralDeleteDirection,
    },
    MoveActive {
        snapshot: OwnershipClosureSnapshot,
        source: StructuralLocation,
        target: StructuralLocation,
    },
    SwapActiveWithDeleted {
        active: OwnershipClosureSnapshot,
        deleted: OwnershipClosureSnapshot,
        direction: LibraryStructuralDeleteDirection,
    },
    RestoreTurnedSelection {
        state: TurnedSelectionState,
    },
    TurnActiveSelection {
        snapshot: OwnershipClosureSnapshot,
        target: LibraryStructuralTurnIntoTarget,
    },
    RestoreBackwardMerge {
        state: BackwardMergeState,
    },
    ApplyBackwardMerge {
        state: BackwardMergeState,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StructuralHistoryRecipe {
    version: u32,
    action: StructuralRecipeAction,
}

type RootExpansion = BTreeMap<String, Vec<String>>;
type DocumentRootExpansions = BTreeMap<String, RootExpansion>;

fn normalize_stored_roots(
    stored_roots: Vec<MaterializedBlockNode>,
) -> Result<(Vec<MaterializedBlockNode>, RootExpansion), StoreError> {
    let mut roots = Vec::new();
    let mut expansion = RootExpansion::new();
    for root in stored_roots {
        let root_id = root.id.clone();
        let normalized = normalize_stored_materialized_forest(&[root])?;
        expansion.insert(
            root_id,
            normalized.iter().map(|block| block.id.clone()).collect(),
        );
        roots.extend(normalized);
    }
    Ok((roots, expansion))
}

fn expand_stored_root_ids(
    stored_root_ids: &[String],
    expansion: &RootExpansion,
) -> Result<Vec<String>, StoreError> {
    let mut expanded = Vec::new();
    for root_id in stored_root_ids {
        let current_root_ids = expansion
            .get(root_id)
            .ok_or_else(|| corrupt("Stored structural root coordinates are incomplete"))?;
        expanded.extend(current_root_ids.iter().cloned());
    }
    Ok(expanded)
}

/// Converts authenticated immutable structural evidence into the current
/// in-memory Document shape. Stored JSON and capability hashes remain exact.
fn normalize_stored_snapshot(
    mut snapshot: OwnershipClosureSnapshot,
) -> Result<
    (
        OwnershipClosureSnapshot,
        RootExpansion,
        DocumentRootExpansions,
    ),
    StoreError,
> {
    let (roots, expansion) = normalize_stored_roots(std::mem::take(&mut snapshot.roots))?;
    snapshot.roots = roots;
    normalize_stored_location(&mut snapshot.source, &expansion)?;

    let mut document_expansions = DocumentRootExpansions::new();
    for document in &mut snapshot.documents {
        let OwnedDocumentBody::Yjs { blocks, .. } = &mut document.body else {
            continue;
        };
        let schema =
            current_schema_for_stored_identity(&document.schema_key, document.schema_version)?;
        let (normalized, root_expansion) = normalize_stored_roots(std::mem::take(blocks))?;
        *blocks = normalized;
        document_expansions.insert(document.document_id.clone(), root_expansion);
        let metadata = schema_metadata(schema);
        document.schema_key = metadata.schema_key.to_owned();
        document.schema_version = i64::from(metadata.schema_version);
    }
    Ok((snapshot, expansion, document_expansions))
}

fn normalize_stored_location(
    location: &mut StructuralLocation,
    expansion: &RootExpansion,
) -> Result<(), StoreError> {
    let mut placements = Vec::new();
    for placement in std::mem::take(&mut location.placements) {
        let root_ids = expansion
            .get(&placement.block_id)
            .ok_or_else(|| corrupt("Stored structural placement names an unknown root"))?;
        placements.extend(root_ids.iter().map(|block_id| RootPlacement {
            block_id: block_id.clone(),
            parent_block_id: placement.parent_block_id.clone(),
            before_block_id: placement.before_block_id.clone(),
        }));
    }
    location.placements = placements;
    Ok(())
}

fn normalize_stored_recipe_action(action: &mut StructuralRecipeAction) -> Result<(), StoreError> {
    match action {
        StructuralRecipeAction::WithInlineContent { action, .. } => {
            normalize_stored_recipe_action(action.as_mut())?;
        }
        StructuralRecipeAction::RestoreDeleted {
            snapshot, target, ..
        } => {
            let (normalized, expansion, _) = normalize_stored_snapshot(snapshot.clone())?;
            *snapshot = normalized;
            normalize_stored_location(target, &expansion)?;
        }
        StructuralRecipeAction::DeleteActive {
            snapshot, source, ..
        } => {
            let (normalized, expansion, _) = normalize_stored_snapshot(snapshot.clone())?;
            *snapshot = normalized;
            normalize_stored_location(source, &expansion)?;
        }
        StructuralRecipeAction::MoveActive {
            snapshot,
            source,
            target,
        } => {
            let (normalized, expansion, _) = normalize_stored_snapshot(snapshot.clone())?;
            *snapshot = normalized;
            normalize_stored_location(source, &expansion)?;
            normalize_stored_location(target, &expansion)?;
        }
        StructuralRecipeAction::SwapActiveWithDeleted {
            active, deleted, ..
        } => {
            *active = normalize_stored_snapshot(active.clone())?.0;
            *deleted = normalize_stored_snapshot(deleted.clone())?.0;
        }
        StructuralRecipeAction::RestoreTurnedSelection { state } => {
            let (original, _, document_expansions) =
                normalize_stored_snapshot(state.original.clone())?;
            state.original = original;
            state.active = normalize_stored_snapshot(state.active.clone())?.0;
            for dormant in &mut state.dormant_pages {
                if dormant.moved_root_ids.is_empty() {
                    continue;
                }
                let expansion = document_expansions
                    .get(&dormant.document_id)
                    .ok_or_else(|| corrupt("Turn history lost Page Document root coordinates"))?;
                dormant.moved_root_ids =
                    expand_stored_root_ids(&dormant.moved_root_ids, expansion)?;
            }
        }
        StructuralRecipeAction::TurnActiveSelection { snapshot, .. } => {
            *snapshot = normalize_stored_snapshot(snapshot.clone())?.0;
        }
        StructuralRecipeAction::RestoreBackwardMerge { state }
        | StructuralRecipeAction::ApplyBackwardMerge { state } => {
            state.snapshot = normalize_stored_snapshot(state.snapshot.clone())?.0;
        }
    }
    Ok(())
}

fn normalize_stored_recipe(
    mut recipe: StructuralHistoryRecipe,
) -> Result<StructuralHistoryRecipe, StoreError> {
    normalize_stored_recipe_action(&mut recipe.action)?;
    Ok(recipe)
}

struct BundleAuthority {
    token: LibraryStructuralClipboardToken,
    snapshot: OwnershipClosureSnapshot,
    cut_claim: Option<CutClaim>,
}

struct CutClaim {
    source_document_id: String,
    source_root_ids: Vec<String>,
    delete_recipe_operation_id: String,
}

#[derive(Clone, Copy)]
struct StructuralWriteContext<'a> {
    connection: &'a Connection,
    context: &'a BoundModuleContext,
    operation_id: &'a str,
    store_epoch: &'a str,
    commit: &'a crate::infrastructure::local_commit::CommitContext,
}

struct AppliedTransition {
    source_root_ids: Vec<String>,
    result_root_ids: Vec<String>,
    document_commits: Vec<LibraryBlockTransferDocumentCommit>,
    inverse: StructuralRecipeAction,
    snapshot: OwnershipClosureSnapshot,
    additional_snapshots: Vec<OwnershipClosureSnapshot>,
    resume: Option<LibraryEditorResumeTarget>,
    file_ownership_effects: PageFileOwnershipMoveEffects,
}

fn transition_snapshot_refs(transition: &AppliedTransition) -> Vec<&OwnershipClosureSnapshot> {
    std::iter::once(&transition.snapshot)
        .chain(transition.additional_snapshots.iter())
        .collect()
}

type CloneTransition = (
    AppliedTransition,
    BTreeMap<String, String>,
    BTreeMap<String, String>,
    Vec<String>,
);

#[allow(clippy::too_many_arguments)]
pub(super) fn apply(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    request_hash: &str,
    command: &LibraryStructuralEditCommand,
    assets_root: &Path,
) -> Result<LibraryApplyOutcome, StoreError> {
    let project_id = bound_project_id(context)?;
    require_project_in_library(connection, project_id, library_id)?;
    match command {
        LibraryStructuralEditCommand::CaptureClipboard { selection } => capture_clipboard(
            connection,
            context,
            library_id,
            operation_id,
            store_epoch,
            request_hash,
            selection,
        ),
        LibraryStructuralEditCommand::DeleteSelection {
            selection,
            reason,
            direction,
        } => delete_selection(
            connection,
            context,
            library_id,
            operation_id,
            store_epoch,
            request_hash,
            selection,
            reason,
            *direction,
        ),
        LibraryStructuralEditCommand::PasteClipboard { bundle, target } => paste_clipboard(
            connection,
            context,
            library_id,
            operation_id,
            store_epoch,
            request_hash,
            bundle,
            target,
            assets_root,
        ),
        LibraryStructuralEditCommand::DuplicateSelection { selection, target } => {
            duplicate_selection(
                connection,
                context,
                library_id,
                operation_id,
                store_epoch,
                request_hash,
                selection,
                target,
                assets_root,
            )
        }
        LibraryStructuralEditCommand::MoveSelection { selection, target } => move_selection(
            connection,
            context,
            library_id,
            operation_id,
            store_epoch,
            request_hash,
            selection,
            target,
        ),
        LibraryStructuralEditCommand::ReplaceSelection {
            selection,
            replacement,
        } => replace_selection(
            connection,
            context,
            library_id,
            operation_id,
            store_epoch,
            request_hash,
            selection,
            replacement,
            assets_root,
        ),
        LibraryStructuralEditCommand::TurnSelectionInto { selection, target } => {
            turn_selection_into(
                connection,
                context,
                library_id,
                operation_id,
                store_epoch,
                request_hash,
                selection,
                target,
            )
        }
        LibraryStructuralEditCommand::MergeBlockBackward {
            selection,
            target_block_id,
        } => merge_block_backward(
            connection,
            context,
            library_id,
            operation_id,
            store_epoch,
            request_hash,
            selection,
            target_block_id,
        ),
        LibraryStructuralEditCommand::ReleaseHistory { tokens } => release_history(
            connection,
            context,
            library_id,
            operation_id,
            store_epoch,
            request_hash,
            tokens,
        ),
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn reverse(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    request_hash: &str,
    token: &LibraryStructuralHistoryToken,
    _assets_root: &Path,
) -> Result<LibraryApplyOutcome, StoreError> {
    let project_id = bound_project_id(context)?;
    require_project_in_library(connection, project_id, library_id)?;
    let recipe = read_history_recipe(connection, library_id, project_id, store_epoch, token)?;
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
            let applied = apply_recipe_action(
                connection,
                context,
                operation_id,
                store_epoch,
                scope.evidence(),
                recipe.action.clone(),
            )?;
            let inverse_recipe = StructuralHistoryRecipe {
                version: RECIPE_VERSION,
                action: applied.inverse.clone(),
            };
            let (history, recipe_json) = history_token(operation_id, store_epoch, &inverse_recipe)?;
            let mut result = structural_result(
                "reverse_structural_edit",
                applied.source_root_ids.clone(),
                applied.result_root_ids.clone(),
                BTreeMap::new(),
                BTreeMap::new(),
                &transition_snapshot_refs(&applied),
                applied.document_commits.clone(),
                None,
                Some(history.clone()),
                Vec::new(),
                applied.resume.clone(),
            );
            let mut effects = structural_effects(
                project_id,
                "reverse_structural_edit",
                &transition_snapshot_refs(&applied),
                &result,
                &now,
            );
            attach_page_file_ownership_effects(
                &mut result,
                &mut effects,
                &applied.file_ownership_effects,
                scope.evidence().commit_seq(),
            );
            seal_mutation_with(
                scope,
                context,
                operation_id,
                effects,
                |_, event_sequence| {
                    persist_structural_mutation_ledger(
                        connection,
                        operation_id,
                        project_id,
                        store_epoch,
                        request_hash,
                        &serde_json::json!({ "kind": "reverse_structural_edit", "token": token }),
                        &result,
                        &transition_snapshot_refs(&applied),
                        event_sequence,
                        &now,
                    )?;
                    insert_history_recipe(
                        connection,
                        operation_id,
                        library_id,
                        project_id,
                        store_epoch,
                        &history.recipe_hash,
                        &recipe_json,
                        &transition_snapshot_refs(&applied),
                        &now,
                    )?;
                    let changed = connection.execute(
                    "UPDATE structural_history_recipes SET state = 'consumed', consumed_at = ?1 \
                     WHERE recipe_operation_id = ?2 AND library_id = ?3 AND project_id = ?4 \
                       AND state = 'available' AND recipe_hash = ?5",
                    params![now, token.recipe_operation_id, library_id, project_id, token.recipe_hash],
                )?;
                    if changed != 1 {
                        return Err(conflict("Structural history token was already consumed"));
                    }
                    connection.execute(
                        "UPDATE structural_cut_claims SET state = 'revoked', revision = revision + 1, \
                           updated_at = ?1 \
                         WHERE delete_recipe_operation_id = ?2 AND state = 'available'",
                        params![now, token.recipe_operation_id],
                    )?;
                    connection.execute(
                        "DELETE FROM structural_retention_members \
                     WHERE authority_kind = 'history_recipe' AND authority_id = ?1",
                        [&token.recipe_operation_id],
                    )?;
                    Ok(())
                },
            )
        },
    )?;
    library_commit_result(connection, commit_result)
}

#[allow(clippy::too_many_arguments)]
fn capture_clipboard(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    request_hash: &str,
    selection: &LibraryStructuralSelection,
) -> Result<LibraryApplyOutcome, StoreError> {
    let project_id = bound_project_id(context)?;
    let parent = load_and_authorize_source(connection, context, library_id, selection, false)?;
    let snapshot = capture_snapshot(connection, library_id, &parent, selection)?;
    let snapshot_json = canonical_json(&snapshot, "Structural clipboard snapshot")?;
    ensure_payload_bound(&snapshot_json, "Structural clipboard snapshot")?;
    let manifest_hash = sha256(snapshot_json.as_bytes());
    let bundle_id = stable_uuid_v7(operation_id, "structural_clipboard_bundle", library_id);
    let capability = random_capability()?;
    let capability_hash = sha256(capability.as_bytes());
    let clipboard = LibraryStructuralClipboardToken {
        bundle_id: bundle_id.clone(),
        capability,
        manifest_hash: manifest_hash.clone(),
        store_epoch: store_epoch.to_owned(),
    };
    let result = structural_result(
        "capture_structural_clipboard",
        root_ids(&snapshot.roots),
        Vec::new(),
        BTreeMap::new(),
        BTreeMap::new(),
        &[&snapshot],
        Vec::new(),
        Some(clipboard),
        None,
        Vec::new(),
        None,
    );
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
            let effects = structural_effects(
                project_id,
                "capture_structural_clipboard",
                &[&snapshot],
                &result,
                &now,
            );
            seal_mutation_with(
                scope,
                context,
                operation_id,
                effects,
                |_, event_sequence| {
                    persist_structural_mutation_ledger(
                        connection,
                        operation_id,
                        project_id,
                        store_epoch,
                        request_hash,
                        &serde_json::json!({
                            "kind": "capture_clipboard",
                            "selection": selection,
                        }),
                        &result,
                        &[&snapshot],
                        event_sequence,
                        &now,
                    )?;
                    release_previous_clipboards(
                        connection, library_id, project_id, &bundle_id, &now,
                    )?;
                    connection.execute(
                        "INSERT INTO structural_clipboard_bundles( \
                       bundle_id, capture_operation_id, library_id, store_epoch, capability_hash, \
                       manifest_hash, snapshot_json, created_at \
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                        params![
                            bundle_id,
                            operation_id,
                            library_id,
                            store_epoch,
                            capability_hash,
                            manifest_hash,
                            snapshot_json,
                            now,
                        ],
                    )?;
                    connection.execute(
                        "INSERT INTO structural_clipboard_leases( \
                       bundle_id, revision, state, released_at, updated_at \
                     ) VALUES (?1, 1, 'active', NULL, ?2)",
                        params![bundle_id, now],
                    )?;
                    insert_retention_members(
                        connection,
                        "clipboard_bundle",
                        &bundle_id,
                        library_id,
                        &[&snapshot],
                    )
                },
            )
        },
    )?;
    library_commit_result(connection, commit_result)
}

#[allow(clippy::too_many_arguments)]
fn delete_selection(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    request_hash: &str,
    selection: &LibraryStructuralSelection,
    reason: &LibraryStructuralDeleteReason,
    direction: LibraryStructuralDeleteDirection,
) -> Result<LibraryApplyOutcome, StoreError> {
    let project_id = bound_project_id(context)?;
    let mut parent = load_and_authorize_source(connection, context, library_id, selection, true)?;
    let snapshot = capture_snapshot(connection, library_id, &parent, selection)?;
    let cut_bundle = match reason {
        LibraryStructuralDeleteReason::Delete => None,
        LibraryStructuralDeleteReason::Cut { bundle } => {
            let authority = read_bundle(connection, library_id, project_id, store_epoch, bundle)?;
            if canonical_snapshot_hash(&authority.snapshot)? != canonical_snapshot_hash(&snapshot)?
            {
                return Err(conflict(
                    "The selected content changed after it was copied to the clipboard",
                ));
            }
            Some(authority)
        }
    };
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
            let applied = delete_snapshot(
                StructuralWriteContext {
                    connection,
                    context,
                    operation_id,
                    store_epoch,
                    commit: scope.evidence(),
                },
                &mut parent,
                snapshot.clone(),
                direction,
            )?;
            let inverse_recipe = StructuralHistoryRecipe {
                version: RECIPE_VERSION,
                action: applied.inverse.clone(),
            };
            let (history, recipe_json) = history_token(operation_id, store_epoch, &inverse_recipe)?;
            let operation_kind = if cut_bundle.is_some() {
                "cut_structural_selection"
            } else {
                "delete_structural_selection"
            };
            let result = structural_result(
                operation_kind,
                root_ids(&snapshot.roots),
                Vec::new(),
                BTreeMap::new(),
                BTreeMap::new(),
                &transition_snapshot_refs(&applied),
                applied.document_commits.clone(),
                None,
                Some(history.clone()),
                Vec::new(),
                applied.resume.clone(),
            );
            let effects = structural_effects(
                project_id,
                operation_kind,
                &transition_snapshot_refs(&applied),
                &result,
                &now,
            );
            seal_mutation_with(
                scope,
                context,
                operation_id,
                effects,
                |_, event_sequence| {
                    persist_structural_mutation_ledger(
                        connection,
                        operation_id,
                        project_id,
                        store_epoch,
                        request_hash,
                        &serde_json::json!({
                            "kind": "delete_selection",
                            "selection": selection,
                            "reason": reason,
                            "direction": direction,
                        }),
                        &result,
                        &transition_snapshot_refs(&applied),
                        event_sequence,
                        &now,
                    )?;
                    insert_history_recipe(
                        connection,
                        operation_id,
                        library_id,
                        project_id,
                        store_epoch,
                        &history.recipe_hash,
                        &recipe_json,
                        &transition_snapshot_refs(&applied),
                        &now,
                    )?;
                    if let Some(bundle) = &cut_bundle {
                        connection.execute(
                            "INSERT INTO structural_cut_claims( \
                           bundle_id, source_document_id, source_root_ids_json, \
                           delete_recipe_operation_id, revision, state, consumed_by_operation_id, \
                           created_at, updated_at \
                         ) VALUES (?1, ?2, ?3, ?4, 1, 'available', NULL, ?5, ?5)",
                            params![
                                bundle.token.bundle_id,
                                snapshot.source.document_id,
                                canonical_json(&root_ids(&snapshot.roots), "Cut roots")?,
                                operation_id,
                                now,
                            ],
                        )?;
                    }
                    Ok(())
                },
            )
        },
    )?;
    library_commit_result(connection, commit_result)
}

#[allow(clippy::too_many_arguments)]
fn paste_clipboard(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    request_hash: &str,
    bundle: &LibraryStructuralClipboardToken,
    target: &LibraryStructuralTarget,
    assets_root: &Path,
) -> Result<LibraryApplyOutcome, StoreError> {
    let project_id = bound_project_id(context)?;
    let authority = read_bundle(connection, library_id, project_id, store_epoch, bundle)?;
    let mut target_parent = load_and_authorize_target(connection, context, library_id, target)?;
    let target_location = target_location(&target_parent, target, &authority.snapshot)?;
    ensure_destination_outside_closure(&authority.snapshot, &target_location)?;
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
            let (applied, copied_block_ids, copied_document_ids, superseded) =
                if let Some(claim) = &authority.cut_claim {
                    let source_page_id = authority.snapshot.source.host_page_id.clone();
                    let candidate_file_ids = authority.snapshot.host_page_file_ids.clone();
                    let mut applied = restore_snapshot(
                        StructuralWriteContext {
                            connection,
                            context,
                            operation_id,
                            store_epoch,
                            commit: scope.evidence(),
                        },
                        &mut target_parent,
                        authority.snapshot.clone(),
                        target_location.clone(),
                        LibraryStructuralDeleteDirection::Backward,
                    )?;
                    applied.file_ownership_effects = move_exclusively_placed_files(
                        connection,
                        library_id,
                        operation_id,
                        project_id,
                        &now,
                        &[PageFilePlacementMove {
                            source_page_id,
                            target_page_id: target_location.host_page_id.clone(),
                            candidate_file_ids,
                        }],
                    )?;
                    let inverse = StructuralRecipeAction::MoveActive {
                        snapshot: applied.snapshot.clone(),
                        source: target_location.clone(),
                        target: authority.snapshot.source.clone(),
                    };
                    (
                        AppliedTransition { inverse, ..applied },
                        BTreeMap::new(),
                        BTreeMap::new(),
                        vec![claim.delete_recipe_operation_id.clone()],
                    )
                } else {
                    clone_snapshot_into_target(
                        connection,
                        context,
                        operation_id,
                        store_epoch,
                        scope.evidence(),
                        &mut target_parent,
                        &authority.snapshot,
                        target_location.clone(),
                        assets_root,
                        &now,
                    )?
                };
            let inverse_recipe = StructuralHistoryRecipe {
                version: RECIPE_VERSION,
                action: applied.inverse.clone(),
            };
            let (history, recipe_json) = history_token(operation_id, store_epoch, &inverse_recipe)?;
            let operation_kind = if authority.cut_claim.is_some() {
                "move_cut_structural_clipboard"
            } else {
                "paste_structural_clipboard"
            };
            let mut result = structural_result(
                operation_kind,
                root_ids(&authority.snapshot.roots),
                applied.result_root_ids.clone(),
                copied_block_ids,
                copied_document_ids,
                &transition_snapshot_refs(&applied),
                applied.document_commits.clone(),
                None,
                Some(history.clone()),
                superseded,
                applied.resume.clone(),
            );
            let mut effects = structural_effects(
                project_id,
                operation_kind,
                &transition_snapshot_refs(&applied),
                &result,
                &now,
            );
            attach_page_file_ownership_effects(
                &mut result,
                &mut effects,
                &applied.file_ownership_effects,
                scope.evidence().commit_seq(),
            );
            seal_mutation_with(
                scope,
                context,
                operation_id,
                effects,
                |_, event_sequence| {
                    persist_structural_mutation_ledger(
                        connection,
                        operation_id,
                        project_id,
                        store_epoch,
                        request_hash,
                        &serde_json::json!({
                            "kind": "paste_clipboard",
                            "bundle": bundle,
                            "target": target,
                        }),
                        &result,
                        &transition_snapshot_refs(&applied),
                        event_sequence,
                        &now,
                    )?;
                    insert_history_recipe(
                        connection,
                        operation_id,
                        library_id,
                        project_id,
                        store_epoch,
                        &history.recipe_hash,
                        &recipe_json,
                        &transition_snapshot_refs(&applied),
                        &now,
                    )?;
                    if let Some(claim) = &authority.cut_claim {
                        consume_cut_claim(
                            connection,
                            operation_id,
                            &now,
                            &bundle.bundle_id,
                            &claim.delete_recipe_operation_id,
                        )?;
                    }
                    Ok(())
                },
            )
        },
    )?;
    library_commit_result(connection, commit_result)
}

#[allow(clippy::too_many_arguments)]
fn duplicate_selection(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    request_hash: &str,
    selection: &LibraryStructuralSelection,
    target: &LibraryStructuralTarget,
    assets_root: &Path,
) -> Result<LibraryApplyOutcome, StoreError> {
    let project_id = bound_project_id(context)?;
    let source_parent =
        load_and_authorize_source(connection, context, library_id, selection, false)?;
    let snapshot = capture_snapshot(connection, library_id, &source_parent, selection)?;
    let mut target_parent = load_and_authorize_target(connection, context, library_id, target)?;
    let target_location = target_location(&target_parent, target, &snapshot)?;
    ensure_destination_outside_closure(&snapshot, &target_location)?;
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
            let (applied, copied_block_ids, copied_document_ids, _) = clone_snapshot_into_target(
                connection,
                context,
                operation_id,
                store_epoch,
                scope.evidence(),
                &mut target_parent,
                &snapshot,
                target_location.clone(),
                assets_root,
                &now,
            )?;
            let inverse_recipe = StructuralHistoryRecipe {
                version: RECIPE_VERSION,
                action: applied.inverse.clone(),
            };
            let (history, recipe_json) = history_token(operation_id, store_epoch, &inverse_recipe)?;
            let result = structural_result(
                "duplicate_structural_selection",
                root_ids(&snapshot.roots),
                applied.result_root_ids.clone(),
                copied_block_ids,
                copied_document_ids,
                &transition_snapshot_refs(&applied),
                applied.document_commits.clone(),
                None,
                Some(history.clone()),
                Vec::new(),
                applied.resume.clone(),
            );
            let effects = structural_effects(
                project_id,
                "duplicate_structural_selection",
                &transition_snapshot_refs(&applied),
                &result,
                &now,
            );
            seal_mutation_with(
                scope,
                context,
                operation_id,
                effects,
                |_, event_sequence| {
                    persist_structural_mutation_ledger(
                        connection,
                        operation_id,
                        project_id,
                        store_epoch,
                        request_hash,
                        &serde_json::json!({
                            "kind": "duplicate_selection",
                            "selection": selection,
                            "target": target,
                        }),
                        &result,
                        &transition_snapshot_refs(&applied),
                        event_sequence,
                        &now,
                    )?;
                    insert_history_recipe(
                        connection,
                        operation_id,
                        library_id,
                        project_id,
                        store_epoch,
                        &history.recipe_hash,
                        &recipe_json,
                        &transition_snapshot_refs(&applied),
                        &now,
                    )
                },
            )
        },
    )?;
    library_commit_result(connection, commit_result)
}

#[allow(clippy::too_many_arguments)]
fn move_selection(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    request_hash: &str,
    selection: &LibraryStructuralSelection,
    target: &LibraryStructuralTarget,
) -> Result<LibraryApplyOutcome, StoreError> {
    let project_id = bound_project_id(context)?;
    let source_parent =
        load_and_authorize_source(connection, context, library_id, selection, true)?;
    let snapshot = capture_snapshot(connection, library_id, &source_parent, selection)?;
    let target_parent = load_and_authorize_target(connection, context, library_id, target)?;
    let target_location = target_location(&target_parent, target, &snapshot)?;
    ensure_destination_outside_closure(&snapshot, &target_location)?;
    let source_location = snapshot.source.clone();
    let source_placeholder = document_would_be_empty(
        &source_parent.base_materialization.block_tree,
        &root_ids(&snapshot.roots),
    )
    .then(|| {
        stable_uuid_v7(
            operation_id,
            "structural_move_placeholder",
            &source_location.document_id,
        )
    });
    let source_resume = (source_location.document_id != target_location.document_id)
        .then(|| {
            deletion_resume_target(
                &source_parent.base_materialization.block_tree,
                &snapshot,
                source_placeholder.as_deref(),
                LibraryStructuralDeleteDirection::Backward,
            )
        })
        .flatten();
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
            let mut applied = move_active_snapshot(
                StructuralWriteContext {
                    connection,
                    context,
                    operation_id,
                    store_epoch,
                    commit: scope.evidence(),
                },
                snapshot.clone(),
                source_location.clone(),
                target_location.clone(),
            )?;
            applied.resume = source_resume.clone();
            let inverse_recipe = StructuralHistoryRecipe {
                version: RECIPE_VERSION,
                action: applied.inverse.clone(),
            };
            let (history, recipe_json) = history_token(operation_id, store_epoch, &inverse_recipe)?;
            let mut result = structural_result(
                "move_structural_selection",
                root_ids(&snapshot.roots),
                applied.result_root_ids.clone(),
                BTreeMap::new(),
                BTreeMap::new(),
                &transition_snapshot_refs(&applied),
                applied.document_commits.clone(),
                None,
                Some(history.clone()),
                Vec::new(),
                applied.resume.clone(),
            );
            let mut effects = structural_effects(
                project_id,
                "move_structural_selection",
                &transition_snapshot_refs(&applied),
                &result,
                &now,
            );
            attach_page_file_ownership_effects(
                &mut result,
                &mut effects,
                &applied.file_ownership_effects,
                scope.evidence().commit_seq(),
            );
            seal_mutation_with(
                scope,
                context,
                operation_id,
                effects,
                |_, event_sequence| {
                    persist_structural_mutation_ledger(
                        connection,
                        operation_id,
                        project_id,
                        store_epoch,
                        request_hash,
                        &serde_json::json!({
                            "kind": "move_selection",
                            "selection": selection,
                            "target": target,
                        }),
                        &result,
                        &transition_snapshot_refs(&applied),
                        event_sequence,
                        &now,
                    )?;
                    insert_history_recipe(
                        connection,
                        operation_id,
                        library_id,
                        project_id,
                        store_epoch,
                        &history.recipe_hash,
                        &recipe_json,
                        &transition_snapshot_refs(&applied),
                        &now,
                    )
                },
            )
        },
    )?;
    library_commit_result(connection, commit_result)
}

#[allow(clippy::too_many_arguments)]
fn replace_selection(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    request_hash: &str,
    selection: &LibraryStructuralSelection,
    replacement: &LibraryStructuralReplacement,
    assets_root: &Path,
) -> Result<LibraryApplyOutcome, StoreError> {
    let project_id = bound_project_id(context)?;
    let mut parent = load_and_authorize_source(connection, context, library_id, selection, true)?;
    let removed = capture_snapshot(connection, library_id, &parent, selection)?;
    reject_primary_databases(connection, &removed.databases)?;
    let bundle = match replacement {
        LibraryStructuralReplacement::Clipboard { bundle } => Some(read_bundle(
            connection,
            library_id,
            project_id,
            store_epoch,
            bundle,
        )?),
        LibraryStructuralReplacement::Blocks { .. } => None,
    };
    let ordinary_blocks = match replacement {
        LibraryStructuralReplacement::Blocks { blocks } => {
            Some(materialize_replacement_blocks(operation_id, blocks)?)
        }
        LibraryStructuralReplacement::Clipboard { .. } => None,
    };
    let replacement_root_ids = bundle
        .as_ref()
        .map(|authority| root_ids(&authority.snapshot.roots))
        .or_else(|| ordinary_blocks.as_ref().map(|blocks| root_ids(blocks)))
        .ok_or_else(|| invalid("Structural replacement is empty"))?;
    let mut target = replacement_location(&removed, &replacement_root_ids)?;
    if let Some(authority) = &bundle {
        ensure_destination_outside_closure(&authority.snapshot, &target)?;
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
            let deleted = delete_snapshot(
                StructuralWriteContext {
                    connection,
                    context,
                    operation_id,
                    store_epoch,
                    commit: scope.evidence(),
                },
                &mut parent,
                removed.clone(),
                LibraryStructuralDeleteDirection::Backward,
            )?;
            target.placeholder_block_id = deleted.snapshot.source.placeholder_block_id.clone();
            let mut target_parent = load_parent_document(connection, &target.document_id)?;
            authorize_parent_write(connection, context, &target_parent)?;
            let (mut inserted, copied_block_ids, copied_document_ids, superseded) =
                if let Some(authority) = &bundle {
                    if let Some(claim) = &authority.cut_claim {
                        let applied = restore_snapshot(
                            StructuralWriteContext {
                                connection,
                                context,
                                operation_id,
                                store_epoch,
                                commit: scope.evidence(),
                            },
                            &mut target_parent,
                            authority.snapshot.clone(),
                            target.clone(),
                            LibraryStructuralDeleteDirection::Backward,
                        )?;
                        (
                            applied,
                            BTreeMap::new(),
                            BTreeMap::new(),
                            vec![claim.delete_recipe_operation_id.clone()],
                        )
                    } else {
                        clone_snapshot_into_target(
                            connection,
                            context,
                            operation_id,
                            store_epoch,
                            scope.evidence(),
                            &mut target_parent,
                            &authority.snapshot,
                            target.clone(),
                            assets_root,
                            &now,
                        )?
                    }
                } else {
                    let blocks = ordinary_blocks
                        .as_ref()
                        .ok_or_else(|| invalid("Structural replacement blocks are missing"))?;
                    (
                        insert_ordinary_replacement(
                            connection,
                            context,
                            library_id,
                            operation_id,
                            store_epoch,
                            scope.evidence(),
                            &mut target_parent,
                            &target,
                            blocks,
                        )?,
                        BTreeMap::new(),
                        BTreeMap::new(),
                        Vec::new(),
                    )
                };
            let deleted_snapshot = deleted.snapshot;
            let active_snapshot = inserted.snapshot.clone();
            inserted.source_root_ids = root_ids(&removed.roots);
            inserted
                .document_commits
                .splice(0..0, deleted.document_commits);
            inserted.inverse = StructuralRecipeAction::SwapActiveWithDeleted {
                active: active_snapshot,
                deleted: deleted_snapshot.clone(),
                direction: LibraryStructuralDeleteDirection::Backward,
            };
            inserted.additional_snapshots.push(deleted_snapshot);
            let inverse_recipe = StructuralHistoryRecipe {
                version: RECIPE_VERSION,
                action: inserted.inverse.clone(),
            };
            let (history, recipe_json) = history_token(operation_id, store_epoch, &inverse_recipe)?;
            let operation_kind = match replacement {
                LibraryStructuralReplacement::Clipboard { .. } => {
                    "replace_structural_selection_with_clipboard"
                }
                LibraryStructuralReplacement::Blocks { .. } => {
                    "replace_structural_selection_with_blocks"
                }
            };
            let snapshots = transition_snapshot_refs(&inserted);
            let result = structural_result(
                operation_kind,
                inserted.source_root_ids.clone(),
                inserted.result_root_ids.clone(),
                copied_block_ids,
                copied_document_ids,
                &snapshots,
                inserted.document_commits.clone(),
                None,
                Some(history.clone()),
                superseded,
                inserted.resume.clone(),
            );
            let effects = structural_effects(project_id, operation_kind, &snapshots, &result, &now);
            seal_mutation_with(
                scope,
                context,
                operation_id,
                effects,
                |_, event_sequence| {
                    persist_structural_mutation_ledger(
                        connection,
                        operation_id,
                        project_id,
                        store_epoch,
                        request_hash,
                        &serde_json::json!({
                            "kind": "replace_selection",
                            "selection": selection,
                            "replacement": replacement,
                        }),
                        &result,
                        &snapshots,
                        event_sequence,
                        &now,
                    )?;
                    insert_history_recipe(
                        connection,
                        operation_id,
                        library_id,
                        project_id,
                        store_epoch,
                        &history.recipe_hash,
                        &recipe_json,
                        &snapshots,
                        &now,
                    )?;
                    if let Some(authority) = &bundle
                        && let Some(claim) = &authority.cut_claim
                    {
                        consume_cut_claim(
                            connection,
                            operation_id,
                            &now,
                            &authority.token.bundle_id,
                            &claim.delete_recipe_operation_id,
                        )?;
                    }
                    Ok(())
                },
            )
        },
    )?;
    library_commit_result(connection, commit_result)
}

#[allow(clippy::too_many_arguments)]
fn turn_selection_into(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    request_hash: &str,
    selection: &LibraryStructuralSelection,
    target: &LibraryStructuralTurnIntoTarget,
) -> Result<LibraryApplyOutcome, StoreError> {
    let project_id = bound_project_id(context)?;
    let parent = load_and_authorize_source(connection, context, library_id, selection, true)?;
    let snapshot = capture_snapshot(connection, library_id, &parent, selection)?;
    validate_turn_selection(connection, &snapshot)?;
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
            let applied = turn_active_selection(
                StructuralWriteContext {
                    connection,
                    context,
                    operation_id,
                    store_epoch,
                    commit: scope.evidence(),
                },
                snapshot.clone(),
                target.clone(),
            )?;
            let inverse_recipe = StructuralHistoryRecipe {
                version: RECIPE_VERSION,
                action: applied.inverse.clone(),
            };
            let (history, recipe_json) = history_token(operation_id, store_epoch, &inverse_recipe)?;
            let snapshots = transition_snapshot_refs(&applied);
            let mut result = structural_result(
                "turn_structural_selection_into",
                applied.source_root_ids.clone(),
                applied.result_root_ids.clone(),
                BTreeMap::new(),
                BTreeMap::new(),
                &snapshots,
                applied.document_commits.clone(),
                None,
                Some(history.clone()),
                Vec::new(),
                applied.resume.clone(),
            );
            if !result
                .affected_page_ids
                .contains(&snapshot.source.host_page_id)
            {
                result
                    .affected_page_ids
                    .push(snapshot.source.host_page_id.clone());
                result.affected_page_ids.sort();
            }
            let effects = structural_effects(
                project_id,
                "turn_structural_selection_into",
                &snapshots,
                &result,
                &now,
            );
            seal_mutation_with(
                scope,
                context,
                operation_id,
                effects,
                |_, event_sequence| {
                    persist_structural_mutation_ledger(
                        connection,
                        operation_id,
                        project_id,
                        store_epoch,
                        request_hash,
                        &serde_json::json!({
                            "kind": "turn_selection_into",
                            "selection": selection,
                            "target": target,
                        }),
                        &result,
                        &snapshots,
                        event_sequence,
                        &now,
                    )?;
                    insert_history_recipe(
                        connection,
                        operation_id,
                        library_id,
                        project_id,
                        store_epoch,
                        &history.recipe_hash,
                        &recipe_json,
                        &snapshots,
                        &now,
                    )
                },
            )
        },
    )?;
    library_commit_result(connection, commit_result)
}

#[allow(clippy::too_many_arguments)]
fn merge_block_backward(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    request_hash: &str,
    selection: &LibraryStructuralSelection,
    target_block_id: &str,
) -> Result<LibraryApplyOutcome, StoreError> {
    let [source_block_id] = selection.root_block_ids.as_slice() else {
        return Err(invalid("Backward merge requires exactly one source Block"));
    };
    if source_block_id == target_block_id {
        return Err(invalid("Backward merge source and target must differ"));
    }
    let project_id = bound_project_id(context)?;
    let parent = load_and_authorize_source(connection, context, library_id, selection, true)?;
    plan_backward_merge(
        &parent.base_materialization.block_tree,
        source_block_id,
        target_block_id,
    )?;
    let snapshot = capture_backward_merge_snapshot(
        connection,
        library_id,
        &parent,
        &LibraryStructuralSelection {
            source_document_id: selection.source_document_id.clone(),
            root_block_ids: vec![target_block_id.to_owned(), source_block_id.clone()],
            source_head: selection.source_head.clone(),
        },
    )?;
    let state = BackwardMergeState {
        snapshot,
        target_block_id: target_block_id.to_owned(),
        source_block_id: source_block_id.clone(),
    };
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
            let applied = apply_backward_merge(
                StructuralWriteContext {
                    connection,
                    context,
                    operation_id,
                    store_epoch,
                    commit: scope.evidence(),
                },
                state.clone(),
            )?;
            let inverse_recipe = StructuralHistoryRecipe {
                version: RECIPE_VERSION,
                action: applied.inverse.clone(),
            };
            let (history, recipe_json) = history_token(operation_id, store_epoch, &inverse_recipe)?;
            let snapshots = transition_snapshot_refs(&applied);
            let result = structural_result(
                "merge_block_backward",
                vec![source_block_id.clone()],
                vec![target_block_id.to_owned()],
                BTreeMap::new(),
                BTreeMap::new(),
                &snapshots,
                applied.document_commits.clone(),
                None,
                Some(history.clone()),
                Vec::new(),
                applied.resume.clone(),
            );
            let effects = structural_effects(
                project_id,
                "merge_block_backward",
                &snapshots,
                &result,
                &now,
            );
            seal_mutation_with(
                scope,
                context,
                operation_id,
                effects,
                |_, event_sequence| {
                    persist_structural_mutation_ledger(
                        connection,
                        operation_id,
                        project_id,
                        store_epoch,
                        request_hash,
                        &serde_json::json!({
                            "kind": "merge_block_backward",
                            "selection": selection,
                            "targetBlockId": target_block_id,
                        }),
                        &result,
                        &snapshots,
                        event_sequence,
                        &now,
                    )?;
                    insert_history_recipe(
                        connection,
                        operation_id,
                        library_id,
                        project_id,
                        store_epoch,
                        &history.recipe_hash,
                        &recipe_json,
                        &snapshots,
                        &now,
                    )
                },
            )
        },
    )?;
    library_commit_result(connection, commit_result)
}

fn validate_turn_selection(
    connection: &Connection,
    snapshot: &OwnershipClosureSnapshot,
) -> Result<(), StoreError> {
    let host_blocks = snapshot
        .blocks
        .iter()
        .filter(|block| block.in_host_document)
        .collect::<Vec<_>>();
    for block in &host_blocks {
        if !is_typed_owner(&block.block_type) || block.block_type == "page" {
            continue;
        }
        return Err(unsupported(format!(
            "{} Blocks cannot be turned into text content",
            block.block_type
        )));
    }
    for page in snapshot.pages.iter().filter(|page| {
        host_blocks
            .iter()
            .any(|block| block.block_id == page.block_id && block.block_type == "page")
    }) {
        if page.parent_kind != "page" || page.parent_id != snapshot.source.host_page_id {
            return Err(unsupported(
                "Only nested Pages in the current Page can be turned into text content",
            ));
        }
        let attached_elsewhere = connection
            .query_row(
                "SELECT 1 WHERE EXISTS (SELECT 1 FROM library_block_placements WHERE block_id = ?1) \
                   OR EXISTS (SELECT 1 FROM data_source_page_memberships \
                              WHERE page_block_id = ?1 AND removed_at IS NULL)",
                [&page.block_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if attached_elsewhere {
            return Err(unsupported(
                "A Page attached to a Library or Data Source cannot be turned into text content",
            ));
        }
    }
    Ok(())
}

fn append_turn_into_operations(
    blocks: &[MaterializedBlockNode],
    parent_block_id: Option<&str>,
    page_plans: &BTreeMap<String, PageToBlockTransformation>,
    target: &LibraryStructuralTurnIntoTarget,
    target_type: &str,
    target_props: &BTreeMap<String, serde_json::Value>,
    operations: &mut Vec<DocumentBlockOperation>,
) {
    for (index, block) in blocks.iter().enumerate() {
        if let Some(plan) = page_plans.get(&block.id) {
            operations.push(DocumentBlockOperation::UpdateBlock {
                block_id: block.id.clone(),
                patch: DocumentBlockUpdatePatch {
                    block_type: Some(plan.block.block_type.clone()),
                    props: Some(plan.block.props.clone()),
                    content: plan.block.content.clone(),
                    unset_content: plan.block.content.is_none(),
                },
            });
            for child in &plan.block.children {
                operations.push(DocumentBlockOperation::InsertBlock {
                    block: child.clone(),
                    parent_block_id: Some(block.id.clone()),
                    before_block_id: None,
                });
            }
            let next_sibling_id = blocks.get(index + 1).map(|sibling| sibling.id.clone());
            for sibling in &plan.trailing_siblings {
                operations.push(DocumentBlockOperation::InsertBlock {
                    block: sibling.clone(),
                    parent_block_id: parent_block_id.map(str::to_owned),
                    before_block_id: next_sibling_id.clone(),
                });
            }
            continue;
        }

        operations.push(DocumentBlockOperation::UpdateBlock {
            block_id: block.id.clone(),
            patch: DocumentBlockUpdatePatch {
                block_type: Some(target_type.to_owned()),
                props: Some(target_props.clone()),
                content: canonical_equation_block_content(target, block.content.as_ref()),
                unset_content: false,
            },
        });
        append_turn_into_operations(
            &block.children,
            Some(&block.id),
            page_plans,
            target,
            target_type,
            target_props,
            operations,
        );
    }
}

fn turn_active_selection(
    write: StructuralWriteContext<'_>,
    original: OwnershipClosureSnapshot,
    target: LibraryStructuralTurnIntoTarget,
) -> Result<AppliedTransition, StoreError> {
    let StructuralWriteContext {
        connection,
        context,
        operation_id,
        store_epoch,
        commit,
    } = write;
    let library_id = connection.query_row(
        "SELECT library_id FROM documents WHERE id = ?1",
        [&original.source.document_id],
        |row| row.get::<_, String>(0),
    )?;
    validate_turn_selection(connection, &original)?;
    let host_parent = load_parent_document(connection, &original.source.document_id)?;
    authorize_parent_write(connection, context, &host_parent)?;
    validate_snapshot_is_at_location(&host_parent, &original, &original.source)?;
    validate_snapshot_authorities(connection, &original, "active")?;

    let host_pages = original
        .blocks
        .iter()
        .filter(|block| block.in_host_document && block.block_type == "page")
        .map(|block| block.block_id.clone())
        .collect::<BTreeSet<_>>();
    let mut page_plans = BTreeMap::new();
    let mut dormant_pages = Vec::new();
    let mut document_commits = Vec::new();
    let mut relocated_block_ids = Vec::new();

    for page_id in &host_pages {
        let document = original
            .documents
            .iter()
            .find(|document| document.owner_block_id == *page_id && document.owner_type == "page")
            .ok_or_else(|| corrupt("Selected Page has no Page Document snapshot"))?;
        let OwnedDocumentBody::Yjs { rich_title, blocks } = &document.body else {
            return Err(corrupt("Selected Page does not own a Yjs Page Document"));
        };
        let plan = plan_page_to_block_transformation(page_id, rich_title, blocks, &target)
            .map_err(|error| invalid(error.to_string()))?;
        let moved_roots = if plan.retained_empty_placeholder_id.is_none() {
            blocks.clone()
        } else {
            Vec::new()
        };
        let moved_ids = flatten_blocks(&moved_roots)
            .into_iter()
            .map(|block| block.id.clone())
            .collect::<Vec<_>>();
        let placeholder_block_id = plan
            .retained_empty_placeholder_id
            .clone()
            .unwrap_or_else(|| stable_uuid_v7(operation_id, "turn_page_placeholder", page_id));

        let mut source_head_seq = document.head_seq;
        if !moved_roots.is_empty() {
            let source_parent = load_parent_document(connection, &document.document_id)?;
            authorize_parent_write(connection, context, &source_parent)?;
            if source_parent.authority.head.generation != document.generation
                || source_parent.authority.head.head_seq != document.head_seq
            {
                return Err(conflict(
                    "A selected Page Document changed before Turn into",
                ));
            }
            let mut operations = moved_roots
                .iter()
                .map(|root| DocumentBlockOperation::DeleteBlock {
                    block_id: root.id.clone(),
                })
                .collect::<Vec<_>>();
            operations.push(DocumentBlockOperation::InsertBlock {
                block: empty_paragraph(&placeholder_block_id),
                parent_block_id: None,
                before_block_id: None,
            });
            let commit_result = persist_parent_relocation_source_with_placeholder(
                connection,
                ParentDocumentWriteContext {
                    actor_project_id: bound_project_id(context)?,
                    store_epoch,
                    operation_id,
                    commit,
                },
                "structural-turn-page-source",
                &source_parent,
                &operations,
                &moved_ids,
            )?;
            source_head_seq = commit_result.head_seq;
            document_commits.push(commit_result);
            relocated_block_ids.extend(moved_ids.iter().cloned());
        }
        let revoked_grant_ids = revoke_page_grants(connection, page_id)?;
        dormant_pages.push(DormantPageState {
            page_id: page_id.clone(),
            document_id: document.document_id.clone(),
            generation: document.generation,
            head_seq: source_head_seq,
            placeholder_block_id,
            moved_root_ids: moved_roots.iter().map(|root| root.id.clone()).collect(),
            moved_block_ids: moved_ids,
            revoked_grant_ids,
        });
        page_plans.insert(page_id.clone(), plan);
    }

    let now = sqlite_now(connection)?;
    let (target_type, target_props) = canonical_ordinary_block_shape(&target);
    for page_id in &host_pages {
        let before = original
            .blocks
            .iter()
            .find(|block| block.block_id == *page_id)
            .ok_or_else(|| corrupt("Selected Page has no Block authority snapshot"))?;
        retire_page_capability(connection, page_id)?;
        let changed = connection.execute(
            "UPDATE blocks SET type = ?1, metadata_revision = metadata_revision + 1, updated_at = ?2 \
             WHERE id = ?3 AND library_id = ?4 AND lifecycle = 'active' AND type = 'page' \
               AND metadata_revision = ?5 AND placement_revision = ?6",
            params![
                target_type,
                now,
                page_id,
                library_id,
                before.metadata_revision,
                before.placement_revision,
            ],
        )?;
        if changed != 1 {
            return Err(conflict("Selected Page changed during Turn into"));
        }
    }

    update_relocated_page_parents(
        connection,
        &original,
        &dormant_pages,
        &original.source.host_page_id,
        &now,
    )?;

    let mut host_operations = Vec::new();
    append_turn_into_operations(
        &original.roots,
        None,
        &page_plans,
        &target,
        target_type,
        &target_props,
        &mut host_operations,
    );
    let host_commit = persist_parent_operations_detailed_with_local_commit(
        connection,
        ParentDocumentWriteContext {
            actor_project_id: bound_project_id(context)?,
            store_epoch,
            operation_id,
            commit,
        },
        "structural-turn-host",
        &host_parent,
        &host_operations,
        ParentDocumentPlacement::Derived {
            attachment_advances: &relocated_block_ids,
        },
    )?;
    document_commits.push(host_commit);
    update_relocated_page_parent_projections(
        connection,
        &original,
        &dormant_pages,
        &original.source.host_page_id,
        &now,
    )?;
    for page in &dormant_pages {
        clear_dormant_document_projections(connection, &page.document_id)?;
    }

    let current_parent = load_parent_document(connection, &original.source.document_id)?;
    let selection = LibraryStructuralSelection {
        source_document_id: original.source.document_id.clone(),
        root_block_ids: root_ids(&original.roots),
        source_head: nodex_core_contracts::library::LibraryDocumentHead {
            document_id: current_parent.authority.head.id.clone(),
            generation: current_parent.authority.head.generation,
            head_seq: current_parent.authority.head.head_seq,
        },
    };
    let active = capture_snapshot(connection, &library_id, &current_parent, &selection)?;
    // The active snapshot no longer owns the demoted Page Documents. Retain
    // the original closure alongside the inverse recipe so Document retention
    // and mutation effects continue to cover those dormant authorities until
    // the history token is consumed or released.
    let retained_original = original.clone();
    let state = TurnedSelectionState {
        original,
        active: active.clone(),
        target: target.clone(),
        dormant_pages,
    };
    let result_root_ids = root_ids(&active.roots);
    let resume = result_root_ids
        .last()
        .map(|block_id| LibraryEditorResumeTarget {
            block_id: block_id.clone(),
            edge: LibraryEditorResumeEdge::End,
            fallback_before_block_id: None,
            fallback_after_block_id: None,
        });
    Ok(AppliedTransition {
        source_root_ids: result_root_ids.clone(),
        result_root_ids,
        document_commits,
        inverse: StructuralRecipeAction::RestoreTurnedSelection { state },
        snapshot: active,
        additional_snapshots: vec![retained_original],
        resume,
        file_ownership_effects: PageFileOwnershipMoveEffects::default(),
    })
}

fn restore_turned_selection(
    write: StructuralWriteContext<'_>,
    state: TurnedSelectionState,
) -> Result<AppliedTransition, StoreError> {
    let StructuralWriteContext {
        connection,
        context,
        operation_id,
        store_epoch,
        commit,
    } = write;
    let parent = load_parent_document(connection, &state.active.source.document_id)?;
    authorize_parent_write(connection, context, &parent)?;
    validate_snapshot_is_at_location(&parent, &state.active, &state.active.source)?;
    validate_snapshot_authorities(connection, &state.active, "active")?;
    for dormant in &state.dormant_pages {
        let current = connection
            .query_row(
                "SELECT generation, head_seq FROM documents WHERE id = ?1",
                [&dormant.document_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?
            .ok_or_else(|| conflict("Dormant Page Document no longer exists"))?;
        if current != (dormant.generation, dormant.head_seq) {
            return Err(conflict("Dormant Page Document changed before Undo"));
        }
        if connection
            .query_row(
                "SELECT 1 FROM block_documents WHERE document_id = ?1 OR block_id = ?2",
                params![dormant.document_id, dormant.page_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
        {
            return Err(conflict("Dormant Page identity was claimed before Undo"));
        }
    }

    let now = sqlite_now(connection)?;
    let library_id = parent.authority.head.library_id.clone();
    for dormant in &state.dormant_pages {
        let original_page = state
            .original
            .pages
            .iter()
            .find(|page| page.block_id == dormant.page_id)
            .ok_or_else(|| corrupt("Turn history lost Page authority"))?;
        let active_block = state
            .active
            .blocks
            .iter()
            .find(|block| block.block_id == dormant.page_id)
            .ok_or_else(|| corrupt("Turn history lost active Block authority"))?;
        let changed = connection.execute(
            "UPDATE blocks SET type = 'page', metadata_revision = metadata_revision + 1, updated_at = ?1 \
             WHERE id = ?2 AND library_id = ?3 AND lifecycle = 'active' AND type <> 'page' \
               AND metadata_revision = ?4 AND placement_revision = ?5",
            params![
                now,
                dormant.page_id,
                library_id,
                active_block.metadata_revision,
                active_block.placement_revision,
            ],
        )?;
        if changed != 1 {
            return Err(conflict("Turned Block changed before Undo"));
        }
        connection.execute(
            "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
             VALUES (?1, ?2, ?3, ?4)",
            params![dormant.page_id, dormant.document_id, library_id, now],
        )?;
        connection.execute(
            "INSERT INTO pages(block_id, library_id, document_id, parent_kind, parent_id, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![
                dormant.page_id,
                library_id,
                dormant.document_id,
                original_page.parent_kind,
                original_page.parent_id,
                now,
            ],
        )?;
        for property in &original_page.properties {
            connection.execute(
                "INSERT INTO block_properties( \
                   block_id, library_id, property_key, value_type, value_json, revision, updated_at \
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
                params![
                    dormant.page_id,
                    library_id,
                    property.property_key,
                    property.value_type,
                    property.value_json,
                    now,
                ],
            )?;
        }
        restore_page_grants(connection, dormant, &now)?;
        let dormant_parent = load_parent_document(connection, &dormant.document_id)?;
        insert_page_read_model(
            connection,
            &dormant.page_id,
            &dormant_parent.base_materialization,
            dormant_parent.authority.head.head_seq,
            &now,
        )?;
        refresh_page_intrinsic_projection(connection, &dormant.page_id, &now)?;
    }

    let moved_ids = state
        .dormant_pages
        .iter()
        .flat_map(|page| page.moved_block_ids.iter().cloned())
        .collect::<Vec<_>>();
    let mut host_operations = Vec::new();
    for original_block in flatten_blocks(&state.original.roots) {
        // A Page shell is childless by schema. Detach the body roots before
        // reclassifying the ordinary container back into a Page so every
        // intermediate operation remains canonical.
        if let Some(dormant) = state
            .dormant_pages
            .iter()
            .find(|page| page.page_id == original_block.id)
        {
            host_operations.extend(dormant.moved_root_ids.iter().map(|block_id| {
                DocumentBlockOperation::DeleteBlock {
                    block_id: block_id.clone(),
                }
            }));
        }
        host_operations.push(DocumentBlockOperation::UpdateBlock {
            block_id: original_block.id.clone(),
            patch: DocumentBlockUpdatePatch {
                block_type: Some(original_block.block_type.clone()),
                props: Some(original_block.props.clone()),
                content: original_block.content.clone(),
                unset_content: original_block.content.is_none(),
            },
        });
    }
    let host_commit = persist_parent_relocation_source_with_local_commit(
        connection,
        ParentDocumentWriteContext {
            actor_project_id: bound_project_id(context)?,
            store_epoch,
            operation_id,
            commit,
        },
        "structural-turn-undo-host",
        &parent,
        &host_operations,
        &moved_ids,
    )?;
    let mut document_commits = vec![host_commit];
    update_relocated_page_parents_to_original(connection, &state, &now)?;

    for dormant in &state.dormant_pages {
        if dormant.moved_root_ids.is_empty() {
            continue;
        }
        let dormant_parent = load_parent_document(connection, &dormant.document_id)?;
        validate_empty_placeholder(&dormant_parent, &dormant.placeholder_block_id)?;
        let original_document = state
            .original
            .documents
            .iter()
            .find(|document| document.document_id == dormant.document_id)
            .ok_or_else(|| corrupt("Turn history lost Page Document body"))?;
        let OwnedDocumentBody::Yjs { blocks, .. } = &original_document.body else {
            return Err(corrupt("Turn history Page Document is not Yjs"));
        };
        let mut operations = vec![DocumentBlockOperation::DeleteBlock {
            block_id: dormant.placeholder_block_id.clone(),
        }];
        operations.extend(
            blocks
                .iter()
                .map(|block| DocumentBlockOperation::InsertBlock {
                    block: block.clone(),
                    parent_block_id: None,
                    before_block_id: None,
                }),
        );
        let commit_result = persist_parent_operations_detailed_with_local_commit(
            connection,
            ParentDocumentWriteContext {
                actor_project_id: bound_project_id(context)?,
                store_epoch,
                operation_id,
                commit,
            },
            "structural-turn-undo-page",
            &dormant_parent,
            &operations,
            ParentDocumentPlacement::Derived {
                attachment_advances: &dormant.moved_block_ids,
            },
        )?;
        document_commits.push(commit_result);
    }
    update_relocated_page_parent_projections_to_original(connection, &state, &now)?;

    let current_parent = load_parent_document(connection, &state.original.source.document_id)?;
    let selection = LibraryStructuralSelection {
        source_document_id: state.original.source.document_id.clone(),
        root_block_ids: root_ids(&state.original.roots),
        source_head: nodex_core_contracts::library::LibraryDocumentHead {
            document_id: current_parent.authority.head.id.clone(),
            generation: current_parent.authority.head.generation,
            head_seq: current_parent.authority.head.head_seq,
        },
    };
    let restored = capture_snapshot(connection, &library_id, &current_parent, &selection)?;
    let result_root_ids = root_ids(&restored.roots);
    let resume = result_root_ids
        .last()
        .map(|block_id| LibraryEditorResumeTarget {
            block_id: block_id.clone(),
            edge: LibraryEditorResumeEdge::End,
            fallback_before_block_id: None,
            fallback_after_block_id: None,
        });
    Ok(AppliedTransition {
        source_root_ids: result_root_ids.clone(),
        result_root_ids,
        document_commits,
        inverse: StructuralRecipeAction::TurnActiveSelection {
            snapshot: restored.clone(),
            target: state.target,
        },
        snapshot: restored,
        additional_snapshots: Vec::new(),
        resume,
        file_ownership_effects: PageFileOwnershipMoveEffects::default(),
    })
}

#[derive(Clone)]
struct BackwardMergePlan {
    target: MaterializedBlockNode,
    source: MaterializedBlockNode,
    merged_content: serde_json::Value,
    source_parent_block_id: Option<String>,
    source_before_block_id: Option<String>,
    promoted_child_ids: Vec<String>,
}

fn find_sibling_context<'a>(
    blocks: &'a [MaterializedBlockNode],
    block_id: &str,
    parent_block_id: Option<&str>,
) -> Option<(Option<String>, usize, &'a [MaterializedBlockNode])> {
    if let Some(index) = blocks.iter().position(|block| block.id == block_id) {
        return Some((parent_block_id.map(str::to_owned), index, blocks));
    }
    blocks
        .iter()
        .find_map(|block| find_sibling_context(&block.children, block_id, Some(&block.id)))
}

fn inline_content(block: &MaterializedBlockNode) -> Option<&Vec<serde_json::Value>> {
    block.content.as_ref()?.as_array()
}

fn plan_backward_merge(
    tree: &[MaterializedBlockNode],
    source_block_id: &str,
    target_block_id: &str,
) -> Result<BackwardMergePlan, StoreError> {
    let (source_parent_block_id, source_index, siblings) =
        find_sibling_context(tree, source_block_id, None).ok_or_else(|| {
            StoreError::new(
                StoreErrorCode::NotFound,
                "Backward merge source Block no longer exists",
                false,
            )
        })?;
    let target_index = siblings
        .iter()
        .position(|block| block.id == target_block_id)
        .ok_or_else(|| invalid("Backward merge target must be a sibling of the source"))?;
    if target_index >= source_index {
        return Err(invalid("Backward merge target must precede the source"));
    }
    let source = siblings[source_index].clone();
    if source.block_type != "paragraph" {
        return Err(invalid(
            "Backward merge source must first normalize to a paragraph",
        ));
    }
    let target = siblings[target_index].clone();
    let target_content = inline_content(&target)
        .ok_or_else(|| invalid("Backward merge target must own inline content"))?;
    let source_content = inline_content(&source)
        .ok_or_else(|| invalid("Backward merge source must own inline content"))?;
    let skipped = &siblings[target_index + 1..source_index];
    if skipped.is_empty() || skipped.iter().any(|block| inline_content(block).is_some()) {
        return Err(invalid(
            "Backward merge target must be the nearest inline Block before an atomic run",
        ));
    }
    let mut merged = Vec::with_capacity(target_content.len() + source_content.len());
    merged.extend(target_content.iter().cloned());
    merged.extend(source_content.iter().cloned());
    Ok(BackwardMergePlan {
        merged_content: serde_json::Value::Array(merged),
        source_before_block_id: siblings.get(source_index + 1).map(|block| block.id.clone()),
        promoted_child_ids: source
            .children
            .iter()
            .map(|child| child.id.clone())
            .collect(),
        source_parent_block_id,
        source,
        target,
    })
}

fn apply_backward_merge(
    write: StructuralWriteContext<'_>,
    mut state: BackwardMergeState,
) -> Result<AppliedTransition, StoreError> {
    let StructuralWriteContext {
        connection,
        context,
        operation_id,
        store_epoch,
        commit,
    } = write;
    let parent = load_parent_document(connection, &state.snapshot.source.document_id)?;
    authorize_parent_write(connection, context, &parent)?;
    validate_snapshot_is_at_location(&parent, &state.snapshot, &state.snapshot.source)?;
    validate_snapshot_authorities(connection, &state.snapshot, "active")?;
    let plan = plan_backward_merge(
        &parent.base_materialization.block_tree,
        &state.source_block_id,
        &state.target_block_id,
    )?;
    let document_commit = persist_parent_operations_detailed_with_local_commit(
        connection,
        ParentDocumentWriteContext {
            actor_project_id: bound_project_id(context)?,
            store_epoch,
            operation_id,
            commit,
        },
        "structural-backward-merge",
        &parent,
        &[DocumentBlockOperation::MergeBlockBackward {
            target_block_id: state.target_block_id.clone(),
            source_block_id: state.source_block_id.clone(),
            merged_content: plan.merged_content,
            promoted_parent_block_id: plan.source_parent_block_id,
            promoted_before_block_id: plan.source_before_block_id,
            promoted_child_ids: plan.promoted_child_ids,
        }],
        ParentDocumentPlacement::Derived {
            attachment_advances: &[],
        },
    )?;
    refresh_snapshot_authorities(connection, &mut state.snapshot)?;
    let retained = state.snapshot.clone();
    Ok(AppliedTransition {
        source_root_ids: vec![state.source_block_id.clone()],
        result_root_ids: vec![state.target_block_id.clone()],
        document_commits: vec![document_commit],
        inverse: StructuralRecipeAction::RestoreBackwardMerge { state },
        snapshot: retained,
        additional_snapshots: Vec::new(),
        resume: Some(LibraryEditorResumeTarget {
            block_id: plan.target.id,
            edge: LibraryEditorResumeEdge::End,
            fallback_before_block_id: None,
            fallback_after_block_id: None,
        }),
        file_ownership_effects: PageFileOwnershipMoveEffects::default(),
    })
}

fn validate_merged_backward_state(
    tree: &[MaterializedBlockNode],
    state: &BackwardMergeState,
) -> Result<BackwardMergePlan, StoreError> {
    if find_block(tree, &state.source_block_id).is_some() {
        return Err(conflict(
            "Backward merge source was restored before history replay",
        ));
    }
    let original_target = find_block(&state.snapshot.roots, &state.target_block_id)
        .ok_or_else(|| corrupt("Backward merge history lost its target Block"))?;
    let original_source = find_block(&state.snapshot.roots, &state.source_block_id)
        .ok_or_else(|| corrupt("Backward merge history lost its source Block"))?;
    let mut merged_target = original_target.clone();
    let mut merged = inline_content(original_target)
        .ok_or_else(|| corrupt("Backward merge history target is not inline"))?
        .clone();
    merged.extend(
        inline_content(original_source)
            .ok_or_else(|| corrupt("Backward merge history source is not inline"))?
            .iter()
            .cloned(),
    );
    merged_target.content = Some(serde_json::Value::Array(merged));
    let current_target = find_block(tree, &state.target_block_id)
        .ok_or_else(|| conflict("Backward merge target no longer exists"))?;
    if current_target != &merged_target {
        return Err(conflict(
            "Backward merge target changed before history replay",
        ));
    }
    let placement = state
        .snapshot
        .source
        .placements
        .iter()
        .find(|placement| placement.block_id == state.source_block_id)
        .ok_or_else(|| corrupt("Backward merge history lost its source placement"))?;
    let siblings = match placement.parent_block_id.as_deref() {
        Some(parent_id) => {
            &find_block(tree, parent_id)
                .ok_or_else(|| conflict("Backward merge source parent no longer exists"))?
                .children
        }
        None => tree,
    };
    let promoted_child_ids = original_source
        .children
        .iter()
        .map(|child| child.id.clone())
        .collect::<Vec<_>>();
    let insertion_index = placement
        .before_block_id
        .as_ref()
        .map(|before_id| {
            siblings
                .iter()
                .position(|block| block.id == *before_id)
                .ok_or_else(|| conflict("Backward merge source anchor no longer exists"))
        })
        .transpose()?
        .unwrap_or(siblings.len());
    if insertion_index < promoted_child_ids.len() {
        return Err(conflict(
            "Backward merge promoted children changed before history replay",
        ));
    }
    let promoted = &siblings[insertion_index - promoted_child_ids.len()..insertion_index];
    if promoted != original_source.children.as_slice() {
        return Err(conflict(
            "Backward merge promoted children changed before history replay",
        ));
    }
    Ok(BackwardMergePlan {
        target: original_target.clone(),
        source: original_source.clone(),
        merged_content: merged_target
            .content
            .clone()
            .ok_or_else(|| corrupt("Backward merge target content is missing"))?,
        source_parent_block_id: placement.parent_block_id.clone(),
        source_before_block_id: placement.before_block_id.clone(),
        promoted_child_ids,
    })
}

fn restore_backward_merge(
    write: StructuralWriteContext<'_>,
    state: BackwardMergeState,
) -> Result<AppliedTransition, StoreError> {
    let StructuralWriteContext {
        connection,
        context,
        operation_id,
        store_epoch,
        commit,
    } = write;
    let parent = load_parent_document(connection, &state.snapshot.source.document_id)?;
    authorize_parent_write(connection, context, &parent)?;
    validate_snapshot_authorities_exact(connection, &state.snapshot)?;
    let plan = validate_merged_backward_state(&parent.base_materialization.block_tree, &state)?;
    let target_content = plan
        .target
        .content
        .clone()
        .ok_or_else(|| corrupt("Backward merge target content is missing"))?;
    let mut source_shell = plan.source.clone();
    source_shell.children.clear();
    let source_id = source_shell.id.clone();
    let reactivated = [source_id.clone()];
    let document_commit = persist_parent_operations_detailed_with_local_commit(
        connection,
        ParentDocumentWriteContext {
            actor_project_id: bound_project_id(context)?,
            store_epoch,
            operation_id,
            commit,
        },
        "structural-backward-merge-undo",
        &parent,
        &[DocumentBlockOperation::RestoreBackwardMerge {
            target_block_id: state.target_block_id.clone(),
            target_content,
            source_block: source_shell,
            source_parent_block_id: plan.source_parent_block_id,
            source_before_block_id: plan.source_before_block_id,
            promoted_child_ids: plan.promoted_child_ids,
        }],
        ParentDocumentPlacement::Restore {
            preapplied: &[],
            tombstone_reactivations: &reactivated,
            source_document_id: &state.snapshot.source.document_id,
            source_document_generation: state.snapshot.source.document_generation,
        },
    )?;
    let current_parent = load_parent_document(connection, &state.snapshot.source.document_id)?;
    let library_id = current_parent.authority.head.library_id.clone();
    let restored = capture_backward_merge_snapshot(
        connection,
        &library_id,
        &current_parent,
        &LibraryStructuralSelection {
            source_document_id: current_parent.authority.head.id.clone(),
            root_block_ids: vec![state.target_block_id.clone(), source_id.clone()],
            source_head: nodex_core_contracts::library::LibraryDocumentHead {
                document_id: current_parent.authority.head.id.clone(),
                generation: current_parent.authority.head.generation,
                head_seq: current_parent.authority.head.head_seq,
            },
        },
    )?;
    let next_state = BackwardMergeState {
        snapshot: restored.clone(),
        target_block_id: state.target_block_id.clone(),
        source_block_id: source_id.clone(),
    };
    Ok(AppliedTransition {
        source_root_ids: vec![state.target_block_id.clone()],
        result_root_ids: vec![source_id.clone()],
        document_commits: vec![document_commit],
        inverse: StructuralRecipeAction::ApplyBackwardMerge { state: next_state },
        snapshot: restored,
        additional_snapshots: Vec::new(),
        resume: Some(LibraryEditorResumeTarget {
            block_id: source_id,
            edge: LibraryEditorResumeEdge::Start,
            fallback_before_block_id: Some(state.target_block_id),
            fallback_after_block_id: None,
        }),
        file_ownership_effects: PageFileOwnershipMoveEffects::default(),
    })
}

fn revoke_page_grants(connection: &Connection, page_id: &str) -> Result<Vec<String>, StoreError> {
    let grant_ids = connection
        .prepare(
            "SELECT id FROM project_resource_grants \
             WHERE root_kind = 'page' AND root_id = ?1 AND lifecycle = 'active' ORDER BY id",
        )?
        .query_map([page_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let now = sqlite_now(connection)?;
    for grant_id in &grant_ids {
        let changed = connection.execute(
            "UPDATE project_resource_grants SET lifecycle = 'revoked', revision = revision + 1, \
               updated_at = ?1 WHERE id = ?2 AND lifecycle = 'active'",
            params![now, grant_id],
        )?;
        if changed != 1 {
            return Err(conflict("Page access changed during Turn into"));
        }
    }
    Ok(grant_ids)
}

fn restore_page_grants(
    connection: &Connection,
    dormant: &DormantPageState,
    now: &str,
) -> Result<(), StoreError> {
    for grant_id in &dormant.revoked_grant_ids {
        let changed = connection.execute(
            "UPDATE project_resource_grants SET lifecycle = 'active', revision = revision + 1, \
               updated_at = ?1 WHERE id = ?2 AND root_kind = 'page' AND root_id = ?3 \
                 AND lifecycle = 'revoked'",
            params![now, grant_id, dormant.page_id],
        )?;
        if changed != 1 {
            return Err(conflict("Page access changed before Turn into Undo"));
        }
    }
    Ok(())
}

fn retire_page_capability(connection: &Connection, page_id: &str) -> Result<(), StoreError> {
    connection.execute(
        "DELETE FROM scheduled_page_index WHERE page_block_id = ?1",
        [page_id],
    )?;
    connection.execute(
        "DELETE FROM page_read_model WHERE page_block_id = ?1",
        [page_id],
    )?;
    connection.execute(
        "DELETE FROM block_properties WHERE block_id = ?1",
        [page_id],
    )?;
    let ownership =
        connection.execute("DELETE FROM block_documents WHERE block_id = ?1", [page_id])?;
    let page = connection.execute("DELETE FROM pages WHERE block_id = ?1", [page_id])?;
    if ownership != 1 || page != 1 {
        return Err(conflict("Page capability changed during Turn into"));
    }
    Ok(())
}

fn clear_dormant_document_projections(
    connection: &Connection,
    document_id: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "DELETE FROM document_page_references WHERE document_id = ?1",
        [document_id],
    )?;
    connection.execute(
        "DELETE FROM block_asset_refs WHERE document_id = ?1",
        [document_id],
    )?;
    connection.execute(
        "DELETE FROM block_search_units WHERE document_id = ?1 AND source_revision IS NULL",
        [document_id],
    )?;
    Ok(())
}

fn moved_page_ids<'a>(
    snapshot: &'a OwnershipClosureSnapshot,
    dormant_pages: &'a [DormantPageState],
) -> impl Iterator<Item = &'a str> {
    snapshot.blocks.iter().filter_map(move |block| {
        (block.block_type == "page"
            && dormant_pages
                .iter()
                .any(|page| page.document_id == block.containing_document_id))
        .then_some(block.block_id.as_str())
    })
}

fn update_relocated_page_parents(
    connection: &Connection,
    snapshot: &OwnershipClosureSnapshot,
    dormant_pages: &[DormantPageState],
    target_host_page_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    for page_id in moved_page_ids(snapshot, dormant_pages) {
        let changed = connection.execute(
            "UPDATE pages SET parent_kind = 'page', parent_id = ?1, updated_at = ?2 \
             WHERE block_id = ?3",
            params![target_host_page_id, now, page_id],
        )?;
        if changed != 1 {
            return Err(conflict("Nested Page parent changed during Turn into"));
        }
    }
    Ok(())
}

fn update_relocated_page_parent_projections(
    connection: &Connection,
    snapshot: &OwnershipClosureSnapshot,
    dormant_pages: &[DormantPageState],
    target_host_page_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    for page_id in moved_page_ids(snapshot, dormant_pages) {
        let changed = connection.execute(
            "UPDATE page_read_model SET parent_kind = 'page', parent_id = ?1, \
               placement_revision = (SELECT placement_revision FROM blocks WHERE id = ?2), \
               metadata_revision = (SELECT metadata_revision FROM blocks WHERE id = ?2), \
               updated_at = ?3 WHERE page_block_id = ?2",
            params![target_host_page_id, page_id, now],
        )?;
        if changed != 1 {
            return Err(conflict("Nested Page projection changed during Turn into"));
        }
    }
    Ok(())
}

fn update_relocated_page_parents_to_original(
    connection: &Connection,
    state: &TurnedSelectionState,
    now: &str,
) -> Result<(), StoreError> {
    for page_id in moved_page_ids(&state.original, &state.dormant_pages) {
        let page = state
            .original
            .pages
            .iter()
            .find(|page| page.block_id == page_id)
            .ok_or_else(|| corrupt("Turn history lost nested Page authority"))?;
        let changed = connection.execute(
            "UPDATE pages SET parent_kind = ?1, parent_id = ?2, updated_at = ?3 \
             WHERE block_id = ?4",
            params![page.parent_kind, page.parent_id, now, page_id],
        )?;
        if changed != 1 {
            return Err(conflict("Nested Page parent changed before Undo"));
        }
    }
    Ok(())
}

fn update_relocated_page_parent_projections_to_original(
    connection: &Connection,
    state: &TurnedSelectionState,
    now: &str,
) -> Result<(), StoreError> {
    for page_id in moved_page_ids(&state.original, &state.dormant_pages) {
        let page = state
            .original
            .pages
            .iter()
            .find(|page| page.block_id == page_id)
            .ok_or_else(|| corrupt("Turn history lost nested Page projection"))?;
        let changed = connection.execute(
            "UPDATE page_read_model SET parent_kind = ?1, parent_id = ?2, \
               placement_revision = (SELECT placement_revision FROM blocks WHERE id = ?3), \
               metadata_revision = (SELECT metadata_revision FROM blocks WHERE id = ?3), \
               updated_at = ?4 WHERE page_block_id = ?3",
            params![page.parent_kind, page.parent_id, page_id, now],
        )?;
        if changed != 1 {
            return Err(conflict("Nested Page projection changed before Undo"));
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn release_history(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    request_hash: &str,
    tokens: &[LibraryStructuralHistoryToken],
) -> Result<LibraryApplyOutcome, StoreError> {
    if tokens.len() > MAX_STRUCTURAL_ROOTS {
        return Err(resource_exhausted(
            "Structural history release exceeds its token bound",
        ));
    }
    let project_id = bound_project_id(context)?;
    let unique_tokens = tokens
        .iter()
        .map(|token| (token.recipe_operation_id.as_str(), token))
        .collect::<BTreeMap<_, _>>();
    if unique_tokens.len() != tokens.len() {
        return Err(invalid(
            "Structural history release contains duplicate tokens",
        ));
    }
    for token in unique_tokens.values() {
        if token.store_epoch != store_epoch {
            return Err(StoreError::new(
                StoreErrorCode::StaleStoreEpoch,
                "Structural history belongs to another Store epoch",
                false,
            ));
        }
        let recipe_hash = connection
            .query_row(
                "SELECT recipe_hash FROM structural_history_recipes \
                 WHERE recipe_operation_id = ?1 AND library_id = ?2 AND project_id = ?3 \
                   AND store_epoch = ?4",
                params![
                    token.recipe_operation_id,
                    library_id,
                    project_id,
                    store_epoch
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| invalid("Structural history token does not exist"))?;
        if !constant_time_equal(recipe_hash.as_bytes(), token.recipe_hash.as_bytes()) {
            return Err(conflict(
                "Structural history token no longer matches its recipe",
            ));
        }
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
            for token in unique_tokens.values() {
                let changed = connection.execute(
                    "UPDATE structural_history_recipes SET state = 'consumed', consumed_at = ?1 \
                     WHERE recipe_operation_id = ?2 AND library_id = ?3 AND project_id = ?4 \
                       AND store_epoch = ?5 AND recipe_hash = ?6 AND state = 'available'",
                    params![
                        now,
                        token.recipe_operation_id,
                        library_id,
                        project_id,
                        store_epoch,
                        token.recipe_hash
                    ],
                )?;
                if changed == 0 {
                    continue;
                }
                connection.execute(
                    "UPDATE structural_cut_claims SET state = 'revoked', revision = revision + 1, \
                       updated_at = ?1 \
                     WHERE delete_recipe_operation_id = ?2 AND state = 'available'",
                    params![now, token.recipe_operation_id],
                )?;
                connection.execute(
                    "DELETE FROM structural_retention_members \
                     WHERE authority_kind = 'history_recipe' AND authority_id = ?1",
                    [&token.recipe_operation_id],
                )?;
            }
            let result = empty_structural_result("release_structural_history");
            let effects = history_release_effects(project_id, &result, &now);
            seal_mutation_with(scope, context, operation_id, effects, |_, _| Ok(()))
        },
    )?;
    library_commit_result(connection, commit_result)
}

fn apply_recipe_action(
    connection: &Connection,
    context: &BoundModuleContext,
    operation_id: &str,
    store_epoch: &str,
    commit: &crate::infrastructure::local_commit::CommitContext,
    action: StructuralRecipeAction,
) -> Result<AppliedTransition, StoreError> {
    let write = StructuralWriteContext {
        connection,
        context,
        operation_id,
        store_epoch,
        commit,
    };
    match action {
        StructuralRecipeAction::WithInlineContent {
            action,
            host_page_id,
            host_document_id,
            block_id,
            expected_content,
            replacement_content,
        } => {
            let mut applied = apply_recipe_action(
                connection,
                context,
                operation_id,
                store_epoch,
                commit,
                *action,
            )?;
            let parent = load_parent_document(connection, &host_document_id)?;
            authorize_parent_write(connection, context, &parent)?;
            if parent.authority.owner_block_id != host_page_id {
                return Err(conflict("Inline history host Page changed"));
            }
            let block = super::mutation::find_materialized_block(
                &parent.base_materialization.block_tree,
                &block_id,
            )
            .ok_or_else(|| conflict("Inline history host Block is unavailable"))?;
            if block.content.as_ref() != Some(&expected_content) {
                return Err(conflict("Inline content changed before history replay"));
            }
            let content_commit = persist_parent_operations_detailed_with_local_commit(
                connection,
                ParentDocumentWriteContext {
                    actor_project_id: bound_project_id(context)?,
                    store_epoch,
                    operation_id,
                    commit,
                },
                "structural-inline-content",
                &parent,
                &[DocumentBlockOperation::UpdateBlock {
                    block_id: block_id.clone(),
                    patch: DocumentBlockUpdatePatch {
                        block_type: None,
                        props: None,
                        content: Some(replacement_content.clone()),
                        unset_content: false,
                    },
                }],
                ParentDocumentPlacement::Derived {
                    attachment_advances: &[],
                },
            )?;
            applied.document_commits.push(content_commit);
            applied.resume = Some(LibraryEditorResumeTarget {
                block_id: block_id.clone(),
                edge: LibraryEditorResumeEdge::End,
                fallback_before_block_id: None,
                fallback_after_block_id: None,
            });
            applied.inverse = StructuralRecipeAction::WithInlineContent {
                action: Box::new(applied.inverse),
                host_page_id,
                host_document_id,
                block_id,
                expected_content: replacement_content,
                replacement_content: expected_content,
            };
            Ok(applied)
        }
        StructuralRecipeAction::RestoreDeleted {
            snapshot,
            target,
            deletion_direction,
        } => {
            let mut parent = load_parent_document(connection, &target.document_id)?;
            authorize_parent_write(connection, context, &parent)?;
            restore_snapshot(write, &mut parent, snapshot, target, deletion_direction)
        }
        StructuralRecipeAction::DeleteActive {
            snapshot,
            source,
            direction,
        } => {
            let mut parent = load_parent_document(connection, &source.document_id)?;
            authorize_parent_write(connection, context, &parent)?;
            validate_snapshot_is_at_location(&parent, &snapshot, &source)?;
            delete_snapshot(write, &mut parent, snapshot, direction)
        }
        StructuralRecipeAction::MoveActive {
            snapshot,
            source,
            target,
        } => move_active_snapshot(write, snapshot, source, target),
        StructuralRecipeAction::SwapActiveWithDeleted {
            active,
            deleted,
            direction,
        } => swap_active_with_deleted(write, active, deleted, direction),
        StructuralRecipeAction::RestoreTurnedSelection { state } => {
            restore_turned_selection(write, state)
        }
        StructuralRecipeAction::TurnActiveSelection { snapshot, target } => {
            turn_active_selection(write, snapshot, target)
        }
        StructuralRecipeAction::RestoreBackwardMerge { state } => {
            restore_backward_merge(write, state)
        }
        StructuralRecipeAction::ApplyBackwardMerge { state } => apply_backward_merge(write, state),
    }
}

fn load_and_authorize_source(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    selection: &LibraryStructuralSelection,
    write: bool,
) -> Result<ResolvedParentDocument, StoreError> {
    let parent = load_parent_document(connection, &selection.source_document_id)?;
    validate_document_head(
        &parent,
        &selection.source_head.document_id,
        selection.source_head.generation,
        selection.source_head.head_seq,
    )?;
    if parent.authority.head.library_id != library_id {
        return Err(unauthorized(
            "Structural selection belongs to another Library",
        ));
    }
    let project_id = bound_project_id(context)?;
    if write {
        super::history::require_page_write_access(
            connection,
            library_id,
            project_id,
            &parent.authority.owner_block_id,
        )?;
    } else {
        super::history::require_page_read_access(
            connection,
            library_id,
            project_id,
            &parent.authority.owner_block_id,
        )?;
    }
    Ok(parent)
}

fn load_and_authorize_target(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    target: &LibraryStructuralTarget,
) -> Result<ResolvedParentDocument, StoreError> {
    let parent = load_parent_document(connection, &target.target_document_id)?;
    validate_document_head(
        &parent,
        &target.target_head.document_id,
        target.target_head.generation,
        target.target_head.head_seq,
    )?;
    if parent.authority.head.library_id != library_id {
        return Err(unauthorized(
            "Structural paste target belongs to another Library",
        ));
    }
    authorize_parent_write(connection, context, &parent)?;
    Ok(parent)
}

fn authorize_parent_write(
    connection: &Connection,
    context: &BoundModuleContext,
    parent: &ResolvedParentDocument,
) -> Result<(), StoreError> {
    super::history::require_page_write_access(
        connection,
        &parent.authority.head.library_id,
        bound_project_id(context)?,
        &parent.authority.owner_block_id,
    )
}

fn validate_document_head(
    parent: &ResolvedParentDocument,
    document_id: &str,
    generation: i64,
    head_seq: i64,
) -> Result<(), StoreError> {
    if parent.authority.head.id != document_id {
        return Err(invalid("Document head identity does not match its command"));
    }
    if parent.authority.head.generation != generation || parent.authority.head.head_seq != head_seq
    {
        return Err(StoreError::new(
            StoreErrorCode::HeadConflict,
            "Document content changed before the structural edit",
            true,
        ));
    }
    Ok(())
}

fn capture_snapshot(
    connection: &Connection,
    library_id: &str,
    parent: &ResolvedParentDocument,
    selection: &LibraryStructuralSelection,
) -> Result<OwnershipClosureSnapshot, StoreError> {
    capture_snapshot_with_policy(connection, library_id, parent, selection, true)
}

fn capture_backward_merge_snapshot(
    connection: &Connection,
    library_id: &str,
    parent: &ResolvedParentDocument,
    selection: &LibraryStructuralSelection,
) -> Result<OwnershipClosureSnapshot, StoreError> {
    // A backward merge relocates descendants inside the same host Page; it
    // never deletes their owner capabilities. Primary Databases are therefore
    // valid descendants even though destructive structural selections reject
    // them.
    capture_snapshot_with_policy(connection, library_id, parent, selection, false)
}

fn capture_snapshot_with_policy(
    connection: &Connection,
    library_id: &str,
    parent: &ResolvedParentDocument,
    selection: &LibraryStructuralSelection,
    reject_protected_databases: bool,
) -> Result<OwnershipClosureSnapshot, StoreError> {
    let (roots, placements) = normalize_selection(
        &parent.base_materialization.block_tree,
        &selection.root_block_ids,
    )?;
    let mut blocks = BTreeMap::new();
    let mut pages = BTreeMap::new();
    let mut databases = BTreeMap::new();
    let mut documents = Vec::new();
    let mut pending_owners = VecDeque::new();
    for block in flatten_blocks(&roots) {
        capture_block_authority(
            connection,
            library_id,
            &parent.authority.head.id,
            true,
            block,
            &mut blocks,
            &mut pages,
            &mut databases,
            &mut pending_owners,
        )?;
    }
    let mut visited_owners = BTreeSet::new();
    while let Some((owner_id, containing_document_id)) = pending_owners.pop_front() {
        if !visited_owners.insert(owner_id.clone()) {
            continue;
        }
        if visited_owners.len() > MAX_STRUCTURAL_DOCUMENTS {
            return Err(resource_exhausted(
                "Structural selection exceeds its owned Document bound",
            ));
        }
        let authority = read_owned_document_authority(connection, library_id, &owner_id)?
            .ok_or_else(|| corrupt("Typed owner has no owned Document authority"))?;
        let body = if authority.owner_type == "canvas" {
            OwnedDocumentBody::Canvas {
                scene: load_canvas_scene(connection, &authority)?.scene,
            }
        } else {
            if !authority.head.is_live_yjs_authority() {
                return Err(unsupported(
                    "Structural clipboard encountered an unsupported owned Document",
                ));
            }
            let schema = crate::document::BlockDocumentSchema::from_identity(
                &authority.head.schema_key,
                authority.head.schema_version,
            )
            .ok_or_else(|| unsupported("Owned Document schema is not supported"))?;
            let engine = crate::document::reconstruct_yjs_engine(connection, &authority.head)?;
            let decoded = crate::document::decode_block_document(engine.document(), schema)
                .map_err(|error| corrupt(format!("Owned Document cannot decode: {error}")))?;
            let materialization = crate::document::materialize_decoded_document(&decoded)
                .map_err(|error| corrupt(format!("Owned Document cannot materialize: {error}")))?;
            for block in flatten_blocks(&materialization.block_tree) {
                capture_block_authority(
                    connection,
                    library_id,
                    &authority.head.id,
                    false,
                    block,
                    &mut blocks,
                    &mut pages,
                    &mut databases,
                    &mut pending_owners,
                )?;
            }
            OwnedDocumentBody::Yjs {
                rich_title: materialization.rich_title,
                blocks: materialization.block_tree,
            }
        };
        documents.push(OwnedDocumentSnapshot {
            owner_block_id: owner_id,
            owner_type: authority.owner_type,
            document_id: authority.head.id,
            containing_document_id,
            schema_key: authority.head.schema_key,
            schema_version: authority.head.schema_version,
            generation: authority.head.generation,
            head_seq: authority.head.head_seq,
            body,
        });
    }
    if blocks.len() > MAX_STRUCTURAL_BLOCKS {
        return Err(resource_exhausted(
            "Structural selection exceeds its Block bound",
        ));
    }
    documents.sort_by(|left, right| left.document_id.cmp(&right.document_id));
    let databases = databases.into_values().collect::<Vec<_>>();
    if reject_protected_databases {
        reject_primary_databases(connection, &databases)?;
    }
    let host_page_file_ids = candidate_file_ids(
        connection,
        library_id,
        &parent.authority.head.id,
        &blocks
            .values()
            .filter(|block| block.in_host_document)
            .map(|block| block.block_id.clone())
            .collect::<Vec<_>>(),
    )?;
    Ok(OwnershipClosureSnapshot {
        version: SNAPSHOT_VERSION,
        roots,
        blocks: blocks.into_values().collect(),
        documents,
        pages: pages.into_values().collect(),
        databases,
        host_page_file_ids,
        source: StructuralLocation {
            document_id: parent.authority.head.id.clone(),
            document_generation: parent.authority.head.generation,
            host_page_id: parent.authority.owner_block_id.clone(),
            placements,
            placeholder_block_id: None,
        },
    })
}

#[allow(clippy::too_many_arguments)]
fn capture_block_authority(
    connection: &Connection,
    library_id: &str,
    containing_document_id: &str,
    in_host_document: bool,
    block: &MaterializedBlockNode,
    blocks: &mut BTreeMap<String, BlockAuthoritySnapshot>,
    pages: &mut BTreeMap<String, PageAuthoritySnapshot>,
    databases: &mut BTreeMap<String, DatabaseAuthoritySnapshot>,
    pending_owners: &mut VecDeque<(String, String)>,
) -> Result<(), StoreError> {
    if blocks.contains_key(&block.id) {
        return Err(corrupt(
            "Structural ownership closure contains a duplicate Block",
        ));
    }
    let authority = connection
        .query_row(
            "SELECT block.type, block.lifecycle, block.metadata_revision, \
                    block.placement_revision, index_row.document_id \
             FROM blocks block JOIN document_block_index index_row ON index_row.block_id = block.id \
             WHERE block.id = ?1 AND block.library_id = ?2",
            params![block.id, library_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| corrupt("Structural materialization references an unknown Block"))?;
    if authority.0 != block.block_type
        || authority.1 != "active"
        || authority.4 != containing_document_id
    {
        return Err(conflict(
            "Structural selection changed during closure capture",
        ));
    }
    blocks.insert(
        block.id.clone(),
        BlockAuthoritySnapshot {
            block_id: block.id.clone(),
            block_type: authority.0.clone(),
            lifecycle: authority.1,
            metadata_revision: authority.2,
            placement_revision: authority.3,
            containing_document_id: containing_document_id.to_owned(),
            in_host_document,
        },
    );
    match authority.0.as_str() {
        "page" => {
            pages.insert(
                block.id.clone(),
                capture_page(connection, library_id, &block.id)?,
            );
        }
        "database" => {
            let database = capture_database(connection, library_id, &block.id)?;
            for row in &database.rows {
                capture_database_row_page(
                    connection,
                    library_id,
                    row,
                    blocks,
                    pages,
                    pending_owners,
                )?;
            }
            databases.insert(block.id.clone(), database);
        }
        _ => {}
    }
    let owned_document = connection
        .query_row(
            "SELECT document_id FROM block_documents WHERE block_id = ?1 AND library_id = ?2",
            params![block.id, library_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if owned_document.is_some() {
        pending_owners.push_back((block.id.clone(), containing_document_id.to_owned()));
    } else if matches!(authority.0.as_str(), "page" | "canvas") {
        return Err(corrupt("Typed owner has no owned Document"));
    }
    Ok(())
}

fn capture_database_row_page(
    connection: &Connection,
    library_id: &str,
    row: &DatabaseRowSnapshot,
    blocks: &mut BTreeMap<String, BlockAuthoritySnapshot>,
    pages: &mut BTreeMap<String, PageAuthoritySnapshot>,
    pending_owners: &mut VecDeque<(String, String)>,
) -> Result<(), StoreError> {
    if blocks.contains_key(&row.page_id) {
        return Err(corrupt(
            "Database row Page appears more than once in a structural closure",
        ));
    }
    let authority = connection
        .query_row(
            "SELECT type, lifecycle, metadata_revision, placement_revision \
             FROM blocks WHERE id = ?1 AND library_id = ?2",
            params![row.page_id, library_id],
            |stored| {
                Ok((
                    stored.get::<_, String>(0)?,
                    stored.get::<_, String>(1)?,
                    stored.get::<_, i64>(2)?,
                    stored.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| corrupt("Database row Page Block is missing"))?;
    if authority.0 != "page" || authority.1 != "active" {
        return Err(conflict("Database row Page changed during closure capture"));
    }
    let page = capture_page(connection, library_id, &row.page_id)?;
    if page.parent_kind != "data_source" || page.parent_id != row.source_id {
        return Err(corrupt(
            "Database row Page parent diverges from its membership",
        ));
    }
    blocks.insert(
        row.page_id.clone(),
        BlockAuthoritySnapshot {
            block_id: row.page_id.clone(),
            block_type: "page".to_owned(),
            lifecycle: authority.1,
            metadata_revision: authority.2,
            placement_revision: authority.3,
            containing_document_id: page.document_id.clone(),
            in_host_document: false,
        },
    );
    pages.insert(row.page_id.clone(), page.clone());
    pending_owners.push_back((row.page_id.clone(), page.document_id));
    Ok(())
}

fn capture_page(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<PageAuthoritySnapshot, StoreError> {
    let (document_id, parent_kind, parent_id) = connection
        .query_row(
            "SELECT document_id, parent_kind, parent_id FROM pages \
             WHERE block_id = ?1 AND library_id = ?2",
            params![page_id, library_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| corrupt("Page Block has no Page authority"))?;
    let properties = connection
        .prepare(
            "SELECT property_key, value_type, value_json FROM block_properties \
             WHERE block_id = ?1 AND library_id = ?2 ORDER BY property_key",
        )?
        .query_map(params![page_id, library_id], |row| {
            Ok(BlockPropertySnapshot {
                property_key: row.get(0)?,
                value_type: row.get(1)?,
                value_json: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(PageAuthoritySnapshot {
        block_id: page_id.to_owned(),
        document_id,
        parent_kind,
        parent_id,
        properties,
    })
}

fn capture_database(
    connection: &Connection,
    library_id: &str,
    database_id: &str,
) -> Result<DatabaseAuthoritySnapshot, StoreError> {
    let mut database = connection
        .query_row(
            "SELECT name, lifecycle, default_view_id, access_revision, metadata_revision \
             FROM database_containers WHERE block_id = ?1 AND library_id = ?2",
            params![database_id, library_id],
            |row| {
                Ok(DatabaseAuthoritySnapshot {
                    block_id: database_id.to_owned(),
                    name: row.get(0)?,
                    lifecycle: row.get(1)?,
                    default_view_id: row.get(2)?,
                    access_revision: row.get(3)?,
                    metadata_revision: row.get(4)?,
                    sources: Vec::new(),
                    properties: Vec::new(),
                    relation_properties: Vec::new(),
                    views: Vec::new(),
                    rows: Vec::new(),
                })
            },
        )
        .optional()?
        .ok_or_else(|| corrupt("Database Block has no Database authority"))?;
    database.sources = connection
        .prepare(
            "SELECT id, name, schema_key, schema_revision, rank_key FROM data_sources \
             WHERE home_database_block_id = ?1 AND library_id = ?2 AND lifecycle = 'active' \
             ORDER BY rank_key, id",
        )?
        .query_map(params![database_id, library_id], |row| {
            Ok(DatabaseSourceSnapshot {
                source_id: row.get(0)?,
                name: row.get(1)?,
                schema_key: row.get(2)?,
                schema_revision: row.get(3)?,
                rank_key: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    database.properties = connection
        .prepare(
            "SELECT property.data_source_id, property.id, property.name, property.value_type, \
                    property.config_json, property.rank_key, property.lifecycle, property.schema_revision \
             FROM data_source_properties property JOIN data_sources source \
               ON source.id = property.data_source_id \
             WHERE source.home_database_block_id = ?1 \
             ORDER BY property.data_source_id, property.rank_key, property.id",
        )?
        .query_map([database_id], |row| {
            Ok(DatabasePropertySnapshot {
                source_id: row.get(0)?,
                property_id: row.get(1)?,
                name: row.get(2)?,
                value_type: row.get(3)?,
                config_json: row.get(4)?,
                rank_key: row.get(5)?,
                lifecycle: row.get(6)?,
                schema_revision: row.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    database.relation_properties = connection
        .prepare(
            "SELECT relation.data_source_id, relation.property_id, \
                    relation.target_data_source_id, relation.cardinality \
             FROM data_source_relation_properties relation \
             JOIN data_sources source ON source.id = relation.data_source_id \
             WHERE source.home_database_block_id = ?1 AND source.library_id = ?2 \
             ORDER BY relation.data_source_id, relation.property_id",
        )?
        .query_map(params![database_id, library_id], |row| {
            Ok(DatabaseRelationPropertySnapshot {
                source_id: row.get(0)?,
                property_id: row.get(1)?,
                target_source_id: row.get(2)?,
                cardinality: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    database.views = connection
        .prepare(
            "SELECT view.id, view.data_source_id, view.name, view.default_layout, view.config_json, \
                    view.revision, view.rank_key, view.lifecycle \
             FROM database_views view WHERE view.database_block_id = ?1 \
             ORDER BY view.rank_key, view.id",
        )?
        .query_map([database_id], |row| {
            Ok(DatabaseViewSnapshot {
                view_id: row.get(0)?,
                source_id: row.get(1)?,
                name: row.get(2)?,
                default_layout: row.get(3)?,
                config_json: row.get(4)?,
                revision: row.get(5)?,
                rank_key: row.get(6)?,
                lifecycle: row.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let rows = connection
        .prepare(
            "SELECT membership.id, membership.data_source_id, membership.page_block_id, \
                    membership.revision, membership.completed_at, model.view_id, \
                    model.view_group_key, model.view_rank_key, model.database_values_json \
             FROM data_source_page_memberships membership \
             JOIN data_sources source ON source.id = membership.data_source_id \
             JOIN page_read_model model ON model.page_block_id = membership.page_block_id \
               AND model.membership_id = membership.id \
             WHERE source.home_database_block_id = ?1 AND source.library_id = ?2 \
               AND source.lifecycle = 'active' AND membership.removed_at IS NULL \
             ORDER BY membership.data_source_id, membership.id",
        )?
        .query_map(params![database_id, library_id], |row| {
            Ok(DatabaseRowSnapshot {
                membership_id: row.get(0)?,
                source_id: row.get(1)?,
                page_id: row.get(2)?,
                revision: row.get(3)?,
                completed_at: row.get(4)?,
                projected_view_id: row.get(5)?,
                view_group_key: row.get(6)?,
                view_rank_key: row.get(7)?,
                database_values_json: row.get(8)?,
                property_values: Vec::new(),
                view_positions: Vec::new(),
                relation_edges: Vec::new(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    database.rows = rows
        .into_iter()
        .map(|mut row| {
            row.property_values = connection
                .prepare(
                    "SELECT property_id, value_type, value_json, revision \
                     FROM data_source_property_values \
                     WHERE data_source_id = ?1 AND membership_id = ?2 ORDER BY property_id",
                )?
                .query_map(params![row.source_id, row.membership_id], |value| {
                    Ok(DatabasePropertyValueSnapshot {
                        property_id: value.get(0)?,
                        value_type: value.get(1)?,
                        value_json: value.get(2)?,
                        revision: value.get(3)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            row.view_positions = connection
                .prepare(
                    "SELECT position.view_id, position.rank_key, position.revision \
                     FROM database_view_page_positions position \
                     JOIN database_views view ON view.id = position.view_id \
                     WHERE position.page_block_id = ?1 AND view.database_block_id = ?2 \
                     ORDER BY position.view_id",
                )?
                .query_map(params![row.page_id, database_id], |position| {
                    Ok(DatabaseViewPositionSnapshot {
                        view_id: position.get(0)?,
                        rank_key: position.get(1)?,
                        revision: position.get(2)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            row.relation_edges = connection
                .prepare(
                    "SELECT edge_id, property_id, target_page_block_id, sibling_rank \
                     FROM data_source_relation_edges \
                     WHERE source_data_source_id = ?1 AND source_membership_id = ?2 \
                     ORDER BY property_id, target_page_block_id",
                )?
                .query_map(params![row.source_id, row.membership_id], |edge| {
                    Ok(DatabaseRelationEdgeSnapshot {
                        edge_id: edge.get(0)?,
                        property_id: edge.get(1)?,
                        target_page_id: edge.get(2)?,
                        sibling_rank: edge.get(3)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(row)
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    Ok(database)
}

fn reject_primary_databases(
    connection: &Connection,
    databases: &[DatabaseAuthoritySnapshot],
) -> Result<(), StoreError> {
    for database in databases {
        let primary = connection
            .query_row(
                "SELECT 1 WHERE EXISTS ( \
                   SELECT 1 FROM project_database_bindings \
                   WHERE database_block_id = ?1 AND lifecycle = 'active' \
                 ) OR EXISTS ( \
                   SELECT 1 FROM projects WHERE database_block_id = ?1 \
                 )",
                [&database.block_id],
                |_| Ok(()),
            )
            .optional()?;
        if primary.is_some() {
            return Err(StoreError::new(
                StoreErrorCode::ProtectedOwnerDeletion,
                "A Project's primary Database cannot be removed by a structural selection",
                false,
            ));
        }
    }
    Ok(())
}

fn normalize_selection(
    tree: &[MaterializedBlockNode],
    requested_ids: &[String],
) -> Result<(Vec<MaterializedBlockNode>, Vec<RootPlacement>), StoreError> {
    if requested_ids.is_empty() || requested_ids.len() > MAX_STRUCTURAL_ROOTS {
        return Err(invalid(
            "Structural selection must contain between 1 and 10000 roots",
        ));
    }
    let requested = requested_ids.iter().cloned().collect::<HashSet<_>>();
    if requested.len() != requested_ids.len() {
        return Err(invalid("Structural selection contains duplicate roots"));
    }
    let all_ids = flatten_blocks(tree)
        .into_iter()
        .map(|block| block.id.as_str())
        .collect::<HashSet<_>>();
    if requested.iter().any(|id| !all_ids.contains(id.as_str())) {
        return Err(StoreError::new(
            StoreErrorCode::NotFound,
            "Structural selection contains a Block that is no longer present",
            false,
        ));
    }
    let mut roots = Vec::new();
    let mut placements = Vec::new();
    collect_normalized_roots(tree, None, &requested, false, &mut roots, &mut placements);
    Ok((roots, placements))
}

fn collect_normalized_roots(
    siblings: &[MaterializedBlockNode],
    parent_id: Option<&str>,
    requested: &HashSet<String>,
    ancestor_selected: bool,
    roots: &mut Vec<MaterializedBlockNode>,
    placements: &mut Vec<RootPlacement>,
) {
    for (index, block) in siblings.iter().enumerate() {
        let selected = requested.contains(&block.id);
        if selected && !ancestor_selected {
            let before_block_id = siblings[index + 1..]
                .iter()
                .find(|candidate| !requested.contains(&candidate.id))
                .map(|candidate| candidate.id.clone());
            roots.push(block.clone());
            placements.push(RootPlacement {
                block_id: block.id.clone(),
                parent_block_id: parent_id.map(str::to_owned),
                before_block_id,
            });
            continue;
        }
        collect_normalized_roots(
            &block.children,
            Some(&block.id),
            requested,
            ancestor_selected || selected,
            roots,
            placements,
        );
    }
}

fn target_location(
    parent: &ResolvedParentDocument,
    target: &LibraryStructuralTarget,
    snapshot: &OwnershipClosureSnapshot,
) -> Result<StructuralLocation, StoreError> {
    validate_insertion_anchor(
        &parent.base_materialization.block_tree,
        target.parent_block_id.as_deref(),
        target.before_block_id.as_deref(),
    )?;
    Ok(StructuralLocation {
        document_id: parent.authority.head.id.clone(),
        document_generation: parent.authority.head.generation,
        host_page_id: parent.authority.owner_block_id.clone(),
        placements: snapshot
            .roots
            .iter()
            .map(|root| RootPlacement {
                block_id: root.id.clone(),
                parent_block_id: target.parent_block_id.clone(),
                before_block_id: target.before_block_id.clone(),
            })
            .collect(),
        placeholder_block_id: None,
    })
}

fn validate_insertion_anchor(
    tree: &[MaterializedBlockNode],
    parent_id: Option<&str>,
    before_id: Option<&str>,
) -> Result<(), StoreError> {
    if let Some(parent_id) = parent_id {
        let parent = flatten_blocks(tree)
            .into_iter()
            .find(|block| block.id == parent_id)
            .ok_or_else(|| invalid("Structural paste parent no longer exists"))?;
        if let Some(before_id) = before_id
            && !parent.children.iter().any(|block| block.id == before_id)
        {
            return Err(invalid(
                "Structural paste anchor is not a child of the requested parent",
            ));
        }
        return Ok(());
    }
    if let Some(before_id) = before_id
        && !tree.iter().any(|block| block.id == before_id)
    {
        return Err(invalid(
            "Structural paste anchor is not a root of the target Document",
        ));
    }
    Ok(())
}

fn ensure_destination_outside_closure(
    snapshot: &OwnershipClosureSnapshot,
    target: &StructuralLocation,
) -> Result<(), StoreError> {
    if snapshot
        .documents
        .iter()
        .any(|document| document.document_id == target.document_id)
    {
        return Err(StoreError::new(
            StoreErrorCode::Conflict,
            "Structural paste destination is inside the copied ownership closure",
            false,
        ));
    }
    Ok(())
}

fn validate_snapshot_is_at_location(
    parent: &ResolvedParentDocument,
    snapshot: &OwnershipClosureSnapshot,
    location: &StructuralLocation,
) -> Result<(), StoreError> {
    if parent.authority.head.id != location.document_id
        || parent.authority.head.generation != location.document_generation
    {
        return Err(conflict("Structural history Document identity changed"));
    }
    let current = location
        .placements
        .iter()
        .map(|placement| {
            find_block(&parent.base_materialization.block_tree, &placement.block_id)
                .cloned()
                .ok_or_else(|| conflict("Structural history root is no longer present"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if current != snapshot.roots {
        return Err(conflict(
            "Structural history target changed and cannot be safely reversed",
        ));
    }
    Ok(())
}

fn root_ids(roots: &[MaterializedBlockNode]) -> Vec<String> {
    roots.iter().map(|root| root.id.clone()).collect()
}

fn flatten_blocks(blocks: &[MaterializedBlockNode]) -> Vec<&MaterializedBlockNode> {
    fn visit<'a>(blocks: &'a [MaterializedBlockNode], output: &mut Vec<&'a MaterializedBlockNode>) {
        for block in blocks {
            output.push(block);
            visit(&block.children, output);
        }
    }
    let mut output = Vec::new();
    visit(blocks, &mut output);
    output
}

fn find_block<'a>(
    blocks: &'a [MaterializedBlockNode],
    block_id: &str,
) -> Option<&'a MaterializedBlockNode> {
    blocks.iter().find_map(|block| {
        if block.id == block_id {
            return Some(block);
        }
        find_block(&block.children, block_id)
    })
}

fn read_owned_document_authority(
    connection: &Connection,
    library_id: &str,
    owner_id: &str,
) -> Result<Option<crate::document::DocumentAuthorityRow>, StoreError> {
    let document_id = connection
        .query_row(
            "SELECT document_id FROM block_documents WHERE block_id = ?1 AND library_id = ?2",
            params![owner_id, library_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    document_id
        .map(|document_id| crate::document::read_document_authority(connection, &document_id))
        .transpose()
        .map(Option::flatten)
}

fn read_bundle(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    store_epoch: &str,
    token: &LibraryStructuralClipboardToken,
) -> Result<BundleAuthority, StoreError> {
    if token.store_epoch != store_epoch {
        return Err(StoreError::new(
            StoreErrorCode::StaleStoreEpoch,
            "Structural clipboard belongs to another Store epoch",
            false,
        ));
    }
    let row = connection
        .query_row(
            "SELECT bundle.capability_hash, bundle.manifest_hash, bundle.snapshot_json, lease.state \
             FROM structural_clipboard_bundles bundle \
             JOIN structural_clipboard_leases lease ON lease.bundle_id = bundle.bundle_id \
             WHERE bundle.bundle_id = ?1 AND bundle.library_id = ?2 AND bundle.store_epoch = ?3",
            params![token.bundle_id, library_id, store_epoch],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| unauthorized("Structural clipboard capability is unavailable"))?;
    if row.3 != "active"
        || !constant_time_equal(
            row.0.as_bytes(),
            sha256(token.capability.as_bytes()).as_bytes(),
        )
        || !constant_time_equal(row.1.as_bytes(), token.manifest_hash.as_bytes())
    {
        return Err(unauthorized("Structural clipboard capability is invalid"));
    }
    let clipboard_snapshot = serde_json::from_str::<OwnershipClosureSnapshot>(&row.2)
        .map_err(|_| corrupt("Structural clipboard snapshot is invalid"))?;
    if clipboard_snapshot.version != SNAPSHOT_VERSION
        || !constant_time_equal(
            sha256(row.2.as_bytes()).as_bytes(),
            token.manifest_hash.as_bytes(),
        )
    {
        return Err(corrupt("Structural clipboard manifest is inconsistent"));
    }
    let cut_claim = connection
        .query_row(
            "SELECT source_document_id, source_root_ids_json, delete_recipe_operation_id \
             FROM structural_cut_claims WHERE bundle_id = ?1 AND state = 'available'",
            [&token.bundle_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?
        .map(
            |(source_document_id, roots_json, delete_recipe_operation_id)| {
                let source_root_ids = serde_json::from_str::<Vec<String>>(&roots_json)
                    .map_err(|_| corrupt("Structural cut claim roots are invalid"))?;
                Ok::<CutClaim, StoreError>(CutClaim {
                    source_document_id,
                    source_root_ids,
                    delete_recipe_operation_id,
                })
            },
        )
        .transpose()?;
    if let Some(claim) = &cut_claim
        && (claim.source_document_id != clipboard_snapshot.source.document_id
            || claim.source_root_ids != root_ids(&clipboard_snapshot.roots))
    {
        return Err(corrupt(
            "Structural cut claim diverges from its clipboard snapshot",
        ));
    }
    let snapshot = if let Some(claim) = &cut_claim {
        let (recipe_hash, recipe_json) = connection
            .query_row(
                "SELECT recipe_hash, recipe_json FROM structural_history_recipes \
                 WHERE recipe_operation_id = ?1 AND library_id = ?2 AND project_id = ?3 \
                   AND store_epoch = ?4 AND state = 'available'",
                params![
                    claim.delete_recipe_operation_id,
                    library_id,
                    project_id,
                    store_epoch,
                ],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
            .ok_or_else(|| conflict("Cut history is no longer available"))?;
        if !constant_time_equal(
            sha256(recipe_json.as_bytes()).as_bytes(),
            recipe_hash.as_bytes(),
        ) {
            return Err(corrupt("Cut history recipe hash is invalid"));
        }
        let recipe = serde_json::from_str::<StructuralHistoryRecipe>(&recipe_json)
            .map_err(|_| corrupt("Cut history recipe is invalid"))?;
        if recipe.version != RECIPE_VERSION {
            return Err(unsupported(
                "Structural history recipe version is unsupported",
            ));
        }
        let recipe = normalize_stored_recipe(recipe)?;
        match recipe.action {
            StructuralRecipeAction::RestoreDeleted { snapshot, .. } => snapshot,
            _ => return Err(corrupt("Cut history does not restore deleted content")),
        }
    } else {
        normalize_stored_snapshot(clipboard_snapshot)?.0
    };
    Ok(BundleAuthority {
        token: token.clone(),
        snapshot,
        cut_claim,
    })
}

fn consume_cut_claim(
    connection: &Connection,
    operation_id: &str,
    now: &str,
    bundle_id: &str,
    delete_recipe_operation_id: &str,
) -> Result<(), StoreError> {
    let changed = connection.execute(
        "UPDATE structural_cut_claims SET state = 'consumed', revision = revision + 1, \
           consumed_by_operation_id = ?1, updated_at = ?2 \
         WHERE bundle_id = ?3 AND state = 'available' \
           AND delete_recipe_operation_id = ?4",
        params![operation_id, now, bundle_id, delete_recipe_operation_id],
    )?;
    if changed != 1 {
        return Err(conflict("Cut clipboard claim was already consumed"));
    }
    let changed = connection.execute(
        "UPDATE structural_history_recipes SET state = 'superseded', consumed_at = ?1, \
           superseded_by_recipe_operation_id = ?2 \
         WHERE recipe_operation_id = ?3 AND state = 'available'",
        params![now, operation_id, delete_recipe_operation_id],
    )?;
    if changed != 1 {
        return Err(conflict("Cut history changed before paste"));
    }
    connection.execute(
        "DELETE FROM structural_retention_members \
         WHERE authority_kind = 'history_recipe' AND authority_id = ?1",
        [delete_recipe_operation_id],
    )?;
    Ok(())
}

fn release_previous_clipboards(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    next_bundle_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    let bundle_ids = connection
        .prepare(
            "SELECT bundle.bundle_id FROM structural_clipboard_bundles bundle \
             JOIN structural_clipboard_leases lease ON lease.bundle_id = bundle.bundle_id \
             JOIN block_mutations mutation ON mutation.mutation_id = bundle.capture_operation_id \
             WHERE bundle.library_id = ?1 AND mutation.project_id = ?2 \
               AND lease.state = 'active' AND bundle.bundle_id <> ?3 \
             ORDER BY bundle.created_at, bundle.bundle_id",
        )?
        .query_map(params![library_id, project_id, next_bundle_id], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for bundle_id in bundle_ids {
        connection.execute(
            "UPDATE structural_cut_claims SET state = 'revoked', revision = revision + 1, \
               updated_at = ?1 WHERE bundle_id = ?2 AND state = 'available'",
            params![now, bundle_id],
        )?;
        connection.execute(
            "UPDATE structural_clipboard_leases SET state = 'released', \
               revision = revision + 1, released_at = ?1, updated_at = ?1 \
             WHERE bundle_id = ?2 AND state = 'active'",
            params![now, bundle_id],
        )?;
        connection.execute(
            "DELETE FROM structural_retention_members \
             WHERE authority_kind = 'clipboard_bundle' AND authority_id = ?1",
            [&bundle_id],
        )?;
        connection.execute(
            "DELETE FROM structural_clipboard_bundles WHERE bundle_id = ?1",
            [&bundle_id],
        )?;
    }
    Ok(())
}

fn read_history_recipe(
    connection: &Connection,
    library_id: &str,
    project_id: &str,
    store_epoch: &str,
    token: &LibraryStructuralHistoryToken,
) -> Result<StructuralHistoryRecipe, StoreError> {
    if token.store_epoch != store_epoch {
        return Err(StoreError::new(
            StoreErrorCode::StaleStoreEpoch,
            "Structural history belongs to another Store epoch",
            false,
        ));
    }
    let row = connection
        .query_row(
            "SELECT recipe_hash, recipe_json, state FROM structural_history_recipes \
             WHERE recipe_operation_id = ?1 AND library_id = ?2 AND project_id = ?3 \
               AND store_epoch = ?4",
            params![
                token.recipe_operation_id,
                library_id,
                project_id,
                store_epoch
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| invalid("Structural history token does not exist"))?;
    if row.2 != "available" || !constant_time_equal(row.0.as_bytes(), token.recipe_hash.as_bytes())
    {
        return Err(conflict("Structural history token is no longer available"));
    }
    if !constant_time_equal(sha256(row.1.as_bytes()).as_bytes(), row.0.as_bytes()) {
        return Err(corrupt("Structural history recipe hash is invalid"));
    }
    let recipe = serde_json::from_str::<StructuralHistoryRecipe>(&row.1)
        .map_err(|_| corrupt("Structural history recipe is invalid"))?;
    if recipe.version != RECIPE_VERSION {
        return Err(unsupported(
            "Structural history recipe version is unsupported",
        ));
    }
    normalize_stored_recipe(recipe)
}

fn history_token(
    operation_id: &str,
    store_epoch: &str,
    recipe: &StructuralHistoryRecipe,
) -> Result<(LibraryStructuralHistoryToken, String), StoreError> {
    let recipe_json = canonical_json(recipe, "Structural history recipe")?;
    ensure_payload_bound(&recipe_json, "Structural history recipe")?;
    let recipe_hash = sha256(recipe_json.as_bytes());
    Ok((
        LibraryStructuralHistoryToken {
            recipe_operation_id: operation_id.to_owned(),
            recipe_hash,
            store_epoch: store_epoch.to_owned(),
        },
        recipe_json,
    ))
}

pub(super) struct PreparedPageMentionHistory {
    snapshot: OwnershipClosureSnapshot,
    result: LibraryStructuralEditResult,
    history: LibraryStructuralHistoryToken,
    recipe_json: String,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn prepare_page_mention_history(
    connection: &Connection,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    destination_page_id: &str,
    destination_document_id: &str,
    created_page_id: &str,
    host_page_id: &str,
    host_document_id: &str,
    host_block_id: &str,
    expected_content: serde_json::Value,
    replacement_content: serde_json::Value,
    document_commits: Vec<LibraryBlockTransferDocumentCommit>,
) -> Result<PreparedPageMentionHistory, StoreError> {
    let parent = load_parent_document(connection, destination_document_id)?;
    if parent.authority.owner_block_id != destination_page_id {
        return Err(conflict("Page mention destination changed during creation"));
    }
    let selection = LibraryStructuralSelection {
        source_document_id: destination_document_id.to_owned(),
        root_block_ids: vec![created_page_id.to_owned()],
        source_head: nodex_core_contracts::library::LibraryDocumentHead {
            document_id: destination_document_id.to_owned(),
            generation: parent.authority.head.generation,
            head_seq: parent.authority.head.head_seq,
        },
    };
    let snapshot = capture_snapshot(connection, library_id, &parent, &selection)?;
    let delete_action = StructuralRecipeAction::DeleteActive {
        snapshot: snapshot.clone(),
        source: snapshot.source.clone(),
        direction: LibraryStructuralDeleteDirection::Backward,
    };
    let inverse_recipe = StructuralHistoryRecipe {
        version: RECIPE_VERSION,
        action: StructuralRecipeAction::WithInlineContent {
            action: Box::new(delete_action),
            host_page_id: host_page_id.to_owned(),
            host_document_id: host_document_id.to_owned(),
            block_id: host_block_id.to_owned(),
            expected_content: replacement_content,
            replacement_content: expected_content,
        },
    };
    let (history, recipe_json) = history_token(operation_id, store_epoch, &inverse_recipe)?;
    let result = structural_result(
        "create_page_mention",
        Vec::new(),
        vec![created_page_id.to_owned()],
        BTreeMap::new(),
        BTreeMap::new(),
        &[&snapshot],
        document_commits,
        None,
        Some(history.clone()),
        Vec::new(),
        Some(LibraryEditorResumeTarget {
            block_id: host_block_id.to_owned(),
            edge: LibraryEditorResumeEdge::End,
            fallback_before_block_id: None,
            fallback_after_block_id: None,
        }),
    );
    Ok(PreparedPageMentionHistory {
        snapshot,
        result,
        history,
        recipe_json,
    })
}

pub(super) fn page_mention_history_result(
    prepared: &PreparedPageMentionHistory,
) -> &LibraryStructuralEditResult {
    &prepared.result
}

pub(super) fn page_mention_history_effects(
    prepared: &PreparedPageMentionHistory,
    project_id: &str,
    now: &str,
) -> MutationEffects {
    structural_effects(
        project_id,
        "create_page_mention",
        &[&prepared.snapshot],
        &prepared.result,
        now,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn persist_page_mention_history(
    connection: &Connection,
    prepared: &PreparedPageMentionHistory,
    operation_id: &str,
    library_id: &str,
    project_id: &str,
    store_epoch: &str,
    request_hash: &str,
    request: &serde_json::Value,
    event_sequence: i64,
    now: &str,
) -> Result<(), StoreError> {
    persist_structural_mutation_ledger(
        connection,
        operation_id,
        project_id,
        store_epoch,
        request_hash,
        request,
        &prepared.result,
        &[&prepared.snapshot],
        event_sequence,
        now,
    )?;
    insert_history_recipe(
        connection,
        operation_id,
        library_id,
        project_id,
        store_epoch,
        &prepared.history.recipe_hash,
        &prepared.recipe_json,
        &[&prepared.snapshot],
        now,
    )
}

#[allow(clippy::too_many_arguments)]
fn persist_structural_mutation_ledger(
    connection: &Connection,
    operation_id: &str,
    project_id: &str,
    store_epoch: &str,
    request_hash: &str,
    request: &serde_json::Value,
    result: &LibraryStructuralEditResult,
    snapshots: &[&OwnershipClosureSnapshot],
    change_log_seq: i64,
    now: &str,
) -> Result<(), StoreError> {
    let target_block_ids = result
        .source_root_block_ids
        .iter()
        .chain(&result.result_root_block_ids)
        .cloned()
        .collect::<BTreeSet<_>>();
    let affected_document_ids = snapshots
        .iter()
        .flat_map(|snapshot| {
            snapshot
                .documents
                .iter()
                .map(|document| document.document_id.clone())
                .chain(std::iter::once(snapshot.source.document_id.clone()))
        })
        .chain(
            result
                .document_commits
                .iter()
                .map(|commit| commit.document_id.clone()),
        )
        .collect::<BTreeSet<_>>();
    let document_heads = result
        .document_commits
        .iter()
        .map(|commit| (commit.document_id.clone(), commit.head_seq))
        .collect::<BTreeMap<_, _>>();
    connection.execute(
        "INSERT INTO block_mutations( \
           mutation_id, project_id, store_epoch, mutation_kind, actor_json, client_session_id, \
           request_hash, request_json, target_block_ids_json, affected_document_ids_json, \
           affected_database_block_ids_json, field_intents_json, expected_revisions_json, outcome, \
           result_json, committed_revisions_json, document_heads_json, change_log_seq, recorded_at \
         ) VALUES (?1, ?2, ?3, 'structural_edit', '{\"kind\":\"editor\"}', NULL, ?4, ?5, \
                   ?6, ?7, ?8, '[]', '{}', 'committed', ?9, '{}', ?10, ?11, ?12)",
        params![
            operation_id,
            project_id,
            store_epoch,
            request_hash,
            canonical_json(request, "Structural request")?,
            canonical_json(&target_block_ids, "Structural target Blocks")?,
            canonical_json(&affected_document_ids, "Structural affected Documents")?,
            canonical_json(
                &result.affected_database_ids,
                "Structural affected Databases",
            )?,
            canonical_json(result, "Structural result")?,
            canonical_json(&document_heads, "Structural Document heads")?,
            change_log_seq,
            now,
        ],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_history_recipe(
    connection: &Connection,
    operation_id: &str,
    library_id: &str,
    project_id: &str,
    store_epoch: &str,
    recipe_hash: &str,
    recipe_json: &str,
    snapshots: &[&OwnershipClosureSnapshot],
    now: &str,
) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO structural_history_recipes( \
           recipe_operation_id, library_id, project_id, store_epoch, recipe_hash, recipe_json, \
           state, consumed_at, superseded_by_recipe_operation_id, created_at \
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'available', NULL, NULL, ?7)",
        params![
            operation_id,
            library_id,
            project_id,
            store_epoch,
            recipe_hash,
            recipe_json,
            now,
        ],
    )?;
    insert_retention_members(
        connection,
        "history_recipe",
        operation_id,
        library_id,
        snapshots,
    )
}

fn insert_retention_members(
    connection: &Connection,
    authority_kind: &str,
    authority_id: &str,
    library_id: &str,
    snapshots: &[&OwnershipClosureSnapshot],
) -> Result<(), StoreError> {
    let block_ids = snapshots
        .iter()
        .flat_map(|snapshot| snapshot.blocks.iter().map(|block| block.block_id.as_str()))
        .collect::<BTreeSet<_>>();
    for block_id in block_ids {
        connection.execute(
            "INSERT INTO structural_retention_members( \
               authority_kind, authority_id, library_id, member_kind, member_id \
             ) VALUES (?1, ?2, ?3, 'block', ?4)",
            params![authority_kind, authority_id, library_id, block_id],
        )?;
    }
    let document_ids = snapshots
        .iter()
        .flat_map(|snapshot| {
            snapshot
                .documents
                .iter()
                .map(|document| document.document_id.as_str())
        })
        .collect::<BTreeSet<_>>();
    for document_id in document_ids {
        connection.execute(
            "INSERT INTO structural_retention_members( \
               authority_kind, authority_id, library_id, member_kind, member_id \
             ) VALUES (?1, ?2, ?3, 'document', ?4)",
            params![authority_kind, authority_id, library_id, document_id],
        )?;
    }
    let database_ids = snapshots
        .iter()
        .flat_map(|snapshot| {
            snapshot
                .databases
                .iter()
                .map(|database| database.block_id.as_str())
        })
        .collect::<BTreeSet<_>>();
    for database_id in database_ids {
        connection.execute(
            "INSERT INTO structural_retention_members( \
               authority_kind, authority_id, library_id, member_kind, member_id \
             ) VALUES (?1, ?2, ?3, 'database', ?4)",
            params![authority_kind, authority_id, library_id, database_id],
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn structural_result(
    operation_kind: &str,
    source_root_block_ids: Vec<String>,
    result_root_block_ids: Vec<String>,
    copied_block_ids: BTreeMap<String, String>,
    copied_document_ids: BTreeMap<String, String>,
    snapshots: &[&OwnershipClosureSnapshot],
    document_commits: Vec<LibraryBlockTransferDocumentCommit>,
    clipboard: Option<LibraryStructuralClipboardToken>,
    history: Option<LibraryStructuralHistoryToken>,
    superseded_history_recipe_operation_ids: Vec<String>,
    resume: Option<LibraryEditorResumeTarget>,
) -> LibraryStructuralEditResult {
    LibraryStructuralEditResult {
        operation_kind: operation_kind.to_owned(),
        source_root_block_ids,
        result_root_block_ids,
        copied_block_ids,
        copied_document_ids,
        document_commits,
        affected_page_ids: snapshots
            .iter()
            .flat_map(|snapshot| snapshot.pages.iter().map(|page| page.block_id.clone()))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        affected_database_ids: snapshots
            .iter()
            .flat_map(|snapshot| {
                snapshot
                    .databases
                    .iter()
                    .map(|database| database.block_id.clone())
            })
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        clipboard,
        history,
        superseded_history_recipe_operation_ids,
        resume,
        file_ownership_moves: Vec::new(),
    }
}

fn empty_structural_result(operation_kind: &str) -> LibraryStructuralEditResult {
    LibraryStructuralEditResult {
        operation_kind: operation_kind.to_owned(),
        source_root_block_ids: Vec::new(),
        result_root_block_ids: Vec::new(),
        copied_block_ids: BTreeMap::new(),
        copied_document_ids: BTreeMap::new(),
        document_commits: Vec::new(),
        affected_page_ids: Vec::new(),
        affected_database_ids: Vec::new(),
        clipboard: None,
        history: None,
        superseded_history_recipe_operation_ids: Vec::new(),
        resume: None,
        file_ownership_moves: Vec::new(),
    }
}

fn history_release_effects(
    project_id: &str,
    result: &LibraryStructuralEditResult,
    now: &str,
) -> MutationEffects {
    MutationEffects {
        project_id: project_id.to_owned(),
        operation_kind: "release_structural_history",
        change_kind: "library.changed",
        did_mutate: false,
        created_target: None,
        affected_parent_keys: Vec::new(),
        affected_block_ids: Vec::new(),
        affected_page_ids: Vec::new(),
        affected_database_ids: Vec::new(),
        affected_view_ids: Vec::new(),
        affected_document_ids: Vec::new(),
        committed_revisions: BTreeMap::new(),
        page_create: None,
        page_copy: None,
        page_files: None,
        canvas_mutation: None,
        block_transfer: None,
        block_transfer_undo: None,
        structural_edit: Some(result.clone()),
        page_lifecycle: None,
        block_property_mutation: None,
        agent_page_copy: None,
        agent_create_pages: None,
        agent_move_pages: None,
        change_payload: None,
        committed_at: now.to_owned(),
    }
}

fn structural_effects(
    project_id: &str,
    operation_kind: &'static str,
    snapshots: &[&OwnershipClosureSnapshot],
    result: &LibraryStructuralEditResult,
    now: &str,
) -> MutationEffects {
    let mut affected_document_ids = snapshots
        .iter()
        .flat_map(|snapshot| {
            snapshot
                .documents
                .iter()
                .map(|document| document.document_id.clone())
                .chain(std::iter::once(snapshot.source.document_id.clone()))
        })
        .chain(
            result
                .document_commits
                .iter()
                .map(|commit| commit.document_id.clone()),
        )
        .collect::<Vec<_>>();
    affected_document_ids.sort();
    affected_document_ids.dedup();
    let committed_revisions = result
        .document_commits
        .iter()
        .map(|commit| {
            (
                format!("documentHead:{}", commit.document_id),
                commit.head_seq,
            )
        })
        .collect();
    MutationEffects {
        project_id: project_id.to_owned(),
        operation_kind,
        change_kind: "library.changed",
        did_mutate: true,
        created_target: None,
        affected_parent_keys: snapshots
            .iter()
            .map(|snapshot| format!("page:{}", snapshot.source.host_page_id))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        affected_block_ids: snapshots
            .iter()
            .flat_map(|snapshot| snapshot.blocks.iter().map(|block| block.block_id.clone()))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        affected_page_ids: result.affected_page_ids.clone(),
        affected_database_ids: result.affected_database_ids.clone(),
        affected_view_ids: snapshots
            .iter()
            .flat_map(|snapshot| {
                snapshot
                    .databases
                    .iter()
                    .flat_map(|database| database.views.iter().map(|view| view.view_id.clone()))
            })
            .collect::<BTreeSet<_>>()
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
        structural_edit: Some(result.clone()),
        page_lifecycle: None,
        block_property_mutation: None,
        agent_page_copy: None,
        agent_create_pages: None,
        agent_move_pages: None,
        change_payload: None,
        committed_at: now.to_owned(),
    }
}

fn attach_page_file_ownership_effects(
    result: &mut LibraryStructuralEditResult,
    effects: &mut MutationEffects,
    ownership: &PageFileOwnershipMoveEffects,
    commit_seq: i64,
) {
    result.file_ownership_moves = ownership.moves.clone();
    effects.structural_edit = Some(result.clone());
    effects
        .affected_page_ids
        .extend(ownership.affected_page_ids.iter().cloned());
    effects.affected_page_ids.sort();
    effects.affected_page_ids.dedup();
    effects.affected_parent_keys.extend(
        ownership
            .affected_page_ids
            .iter()
            .map(|page_id| format!("page:{page_id}")),
    );
    effects.affected_parent_keys.sort();
    effects.affected_parent_keys.dedup();
    effects
        .committed_revisions
        .extend(ownership.committed_revisions(commit_seq));
}

fn canonical_snapshot_hash(snapshot: &OwnershipClosureSnapshot) -> Result<String, StoreError> {
    canonical_json(snapshot, "Structural snapshot").map(|json| sha256(json.as_bytes()))
}

fn canonical_json<T: Serialize>(value: &T, label: &str) -> Result<String, StoreError> {
    serde_json::to_string(value).map_err(|_| internal(format!("{label} cannot encode")))
}

fn ensure_payload_bound(payload: &str, label: &str) -> Result<(), StoreError> {
    if (2..=64 * 1024 * 1024).contains(&payload.len()) {
        return Ok(());
    }
    Err(resource_exhausted(format!(
        "{label} exceeds its 64 MiB bound"
    )))
}

fn random_capability() -> Result<String, StoreError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| internal("Structural clipboard capability entropy failed"))?;
    Ok(hex::encode(bytes))
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

fn bound_project_id(context: &BoundModuleContext) -> Result<&str, StoreError> {
    context
        .project_id
        .as_ref()
        .map(|project_id| project_id.0.as_str())
        .ok_or_else(|| unauthorized("Structural editing requires a bound Project"))
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn conflict(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::RevisionConflict, message, false)
}

fn unauthorized(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Unauthorized, message, false)
}

fn unsupported(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::UnsupportedSchema, message, false)
}

fn resource_exhausted(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::ResourceExhausted, message, false)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn internal(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

fn materialize_replacement_blocks(
    operation_id: &str,
    blocks: &[LibraryStructuralReplacementBlock],
) -> Result<Vec<MaterializedBlockNode>, StoreError> {
    if blocks.is_empty() || blocks.len() > MAX_STRUCTURAL_ROOTS {
        return Err(invalid(
            "Structural replacement must contain between 1 and 10000 roots",
        ));
    }
    let encoded = canonical_json(&blocks, "Structural replacement blocks")?;
    ensure_payload_bound(&encoded, "Structural replacement blocks")?;
    let mut count = 0_usize;

    fn materialize(
        operation_id: &str,
        input: &LibraryStructuralReplacementBlock,
        path: &str,
        depth: usize,
        count: &mut usize,
    ) -> Result<MaterializedBlockNode, StoreError> {
        if depth > MAX_STRUCTURAL_DEPTH {
            return Err(resource_exhausted(
                "Structural replacement exceeds its 128-level depth bound",
            ));
        }
        *count = count
            .checked_add(1)
            .ok_or_else(|| resource_exhausted("Structural replacement Block count overflowed"))?;
        if *count > MAX_STRUCTURAL_BLOCKS {
            return Err(resource_exhausted(
                "Structural replacement exceeds its 10000 Block bound",
            ));
        }
        if input.block_type.is_empty() || input.block_type.len() > 128 {
            return Err(invalid("Structural replacement Block type is invalid"));
        }
        if is_typed_owner(&input.block_type) {
            return Err(invalid(
                "Owned content must be inserted from a structural clipboard capability",
            ));
        }
        let children = input
            .children
            .iter()
            .enumerate()
            .map(|(index, child)| {
                materialize(
                    operation_id,
                    child,
                    &format!("{path}.{index}"),
                    depth + 1,
                    count,
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(MaterializedBlockNode {
            id: stable_uuid_v7(
                operation_id,
                "structural_replacement_block",
                &format!("{path}:{}", input.block_type),
            ),
            block_type: input.block_type.clone(),
            props: input.props.clone(),
            content: input.content.clone(),
            children,
        })
    }

    blocks
        .iter()
        .enumerate()
        .map(|(index, block)| materialize(operation_id, block, &index.to_string(), 0, &mut count))
        .collect()
}

fn replacement_location(
    removed: &OwnershipClosureSnapshot,
    replacement_root_ids: &[String],
) -> Result<StructuralLocation, StoreError> {
    let first = removed
        .source
        .placements
        .first()
        .ok_or_else(|| corrupt("Structural selection has no replacement placement"))?;
    Ok(StructuralLocation {
        document_id: removed.source.document_id.clone(),
        document_generation: removed.source.document_generation,
        host_page_id: removed.source.host_page_id.clone(),
        placements: replacement_root_ids
            .iter()
            .map(|block_id| RootPlacement {
                block_id: block_id.clone(),
                parent_block_id: first.parent_block_id.clone(),
                before_block_id: first.before_block_id.clone(),
            })
            .collect(),
        placeholder_block_id: None,
    })
}

#[allow(clippy::too_many_arguments)]
fn insert_ordinary_replacement(
    connection: &Connection,
    context: &BoundModuleContext,
    library_id: &str,
    operation_id: &str,
    store_epoch: &str,
    commit: &crate::infrastructure::local_commit::CommitContext,
    parent: &mut ResolvedParentDocument,
    target: &StructuralLocation,
    blocks: &[MaterializedBlockNode],
) -> Result<AppliedTransition, StoreError> {
    if parent.authority.head.id != target.document_id
        || parent.authority.head.generation != target.document_generation
    {
        return Err(conflict("Structural replacement target Document changed"));
    }
    let first = target
        .placements
        .first()
        .ok_or_else(|| corrupt("Structural replacement target is empty"))?;
    validate_insertion_anchor(
        &parent.base_materialization.block_tree,
        first.parent_block_id.as_deref(),
        first.before_block_id.as_deref(),
    )?;
    let mut operations = Vec::new();
    if let Some(placeholder_id) = &target.placeholder_block_id {
        validate_empty_placeholder(parent, placeholder_id)?;
        operations.push(DocumentBlockOperation::DeleteBlock {
            block_id: placeholder_id.clone(),
        });
    }
    for block in blocks {
        let placement = target
            .placements
            .iter()
            .find(|placement| placement.block_id == block.id)
            .ok_or_else(|| corrupt("Structural replacement placement is incomplete"))?;
        operations.push(DocumentBlockOperation::InsertBlock {
            block: block.clone(),
            parent_block_id: placement.parent_block_id.clone(),
            before_block_id: placement.before_block_id.clone(),
        });
    }
    let document_commit = persist_parent_operations_detailed_with_local_commit(
        connection,
        ParentDocumentWriteContext {
            actor_project_id: bound_project_id(context)?,
            store_epoch,
            operation_id,
            commit,
        },
        "structural-replacement-blocks",
        parent,
        &operations,
        ParentDocumentPlacement::Derived {
            attachment_advances: &[],
        },
    )?;
    let current_parent = load_parent_document(connection, &target.document_id)?;
    let selection = LibraryStructuralSelection {
        source_document_id: target.document_id.clone(),
        root_block_ids: root_ids(blocks),
        source_head: nodex_core_contracts::library::LibraryDocumentHead {
            document_id: target.document_id.clone(),
            generation: current_parent.authority.head.generation,
            head_seq: current_parent.authority.head.head_seq,
        },
    };
    let snapshot = capture_snapshot(connection, library_id, &current_parent, &selection)?;
    let source = StructuralLocation {
        placeholder_block_id: None,
        ..target.clone()
    };
    let inverse = StructuralRecipeAction::DeleteActive {
        snapshot: snapshot.clone(),
        source,
        direction: LibraryStructuralDeleteDirection::Backward,
    };
    let result_root_ids = root_ids(&snapshot.roots);
    let resume = result_root_ids
        .last()
        .map(|block_id| LibraryEditorResumeTarget {
            block_id: block_id.clone(),
            edge: LibraryEditorResumeEdge::End,
            fallback_before_block_id: None,
            fallback_after_block_id: None,
        });
    Ok(AppliedTransition {
        source_root_ids: Vec::new(),
        result_root_ids,
        document_commits: vec![document_commit],
        inverse,
        snapshot,
        additional_snapshots: Vec::new(),
        resume,
        file_ownership_effects: PageFileOwnershipMoveEffects::default(),
    })
}

fn delete_snapshot(
    write: StructuralWriteContext<'_>,
    parent: &mut ResolvedParentDocument,
    mut snapshot: OwnershipClosureSnapshot,
    direction: LibraryStructuralDeleteDirection,
) -> Result<AppliedTransition, StoreError> {
    let StructuralWriteContext {
        connection,
        context,
        operation_id,
        store_epoch,
        commit,
    } = write;
    validate_snapshot_is_at_location(parent, &snapshot, &snapshot.source)?;
    validate_snapshot_authorities(connection, &snapshot, "active")?;
    let root_block_ids = root_ids(&snapshot.roots);
    let placeholder =
        document_would_be_empty(&parent.base_materialization.block_tree, &root_block_ids).then(
            || {
                stable_uuid_v7(
                    operation_id,
                    "structural_placeholder",
                    &snapshot.source.document_id,
                )
            },
        );
    let resume = deletion_resume_target(
        &parent.base_materialization.block_tree,
        &snapshot,
        placeholder.as_deref(),
        direction,
    );
    transition_closure_lifecycle(connection, &snapshot, "active", "deleted", None, false)?;
    let mut operations = root_block_ids
        .iter()
        .map(|block_id| DocumentBlockOperation::DeleteBlock {
            block_id: block_id.clone(),
        })
        .collect::<Vec<_>>();
    if let Some(placeholder_id) = &placeholder {
        operations.push(DocumentBlockOperation::InsertBlock {
            block: empty_paragraph(placeholder_id),
            parent_block_id: None,
            before_block_id: None,
        });
    }
    let document_commit = persist_parent_operations_detailed_with_local_commit(
        connection,
        ParentDocumentWriteContext {
            actor_project_id: bound_project_id(context)?,
            store_epoch,
            operation_id,
            commit,
        },
        "structural-delete",
        parent,
        &operations,
        ParentDocumentPlacement::Derived {
            attachment_advances: &[],
        },
    )?;
    snapshot.source.placeholder_block_id = placeholder;
    refresh_snapshot_authorities(connection, &mut snapshot)?;
    let inverse = StructuralRecipeAction::RestoreDeleted {
        snapshot: snapshot.clone(),
        target: snapshot.source.clone(),
        deletion_direction: direction,
    };
    Ok(AppliedTransition {
        source_root_ids: root_ids(&snapshot.roots),
        result_root_ids: Vec::new(),
        document_commits: vec![document_commit],
        inverse,
        snapshot,
        additional_snapshots: Vec::new(),
        resume,
        file_ownership_effects: PageFileOwnershipMoveEffects::default(),
    })
}

fn restore_snapshot(
    write: StructuralWriteContext<'_>,
    parent: &mut ResolvedParentDocument,
    mut snapshot: OwnershipClosureSnapshot,
    target: StructuralLocation,
    deletion_direction: LibraryStructuralDeleteDirection,
) -> Result<AppliedTransition, StoreError> {
    let StructuralWriteContext {
        connection,
        context,
        operation_id,
        store_epoch,
        commit,
    } = write;
    validate_snapshot_authorities(connection, &snapshot, "deleted")?;
    validate_restore_target(parent, &snapshot, &target)?;
    let defers_page_projection = target.document_id != snapshot.source.document_id;
    transition_closure_lifecycle(
        connection,
        &snapshot,
        "deleted",
        "active",
        Some(&target.host_page_id),
        defers_page_projection,
    )?;
    let mut operations = Vec::new();
    if let Some(placeholder_id) = &target.placeholder_block_id {
        validate_empty_placeholder(parent, placeholder_id)?;
        operations.push(DocumentBlockOperation::DeleteBlock {
            block_id: placeholder_id.clone(),
        });
    }
    for root in &snapshot.roots {
        let placement = target
            .placements
            .iter()
            .find(|placement| placement.block_id == root.id)
            .ok_or_else(|| corrupt("Structural restore placement is incomplete"))?;
        operations.push(DocumentBlockOperation::InsertBlock {
            block: root.clone(),
            parent_block_id: placement.parent_block_id.clone(),
            before_block_id: placement.before_block_id.clone(),
        });
    }
    let preapplied = snapshot
        .blocks
        .iter()
        .filter(|block| block.in_host_document && is_typed_owner(&block.block_type))
        .map(|block| block.block_id.clone())
        .collect::<Vec<_>>();
    let tombstone_reactivations = snapshot
        .blocks
        .iter()
        .filter(|block| block.in_host_document && !is_typed_owner(&block.block_type))
        .map(|block| block.block_id.clone())
        .collect::<Vec<_>>();
    let placement = ParentDocumentPlacement::Restore {
        preapplied: &preapplied,
        tombstone_reactivations: &tombstone_reactivations,
        source_document_id: &snapshot.source.document_id,
        source_document_generation: snapshot.source.document_generation,
    };
    let document_commit = persist_parent_operations_detailed_with_local_commit(
        connection,
        ParentDocumentWriteContext {
            actor_project_id: bound_project_id(context)?,
            store_epoch,
            operation_id,
            commit,
        },
        "structural-restore",
        parent,
        &operations,
        placement,
    )?;
    if defers_page_projection {
        transition_page_projections(
            connection,
            &snapshot,
            "deleted",
            "active",
            Some(&target.host_page_id),
        )?;
    }
    let restored_root_ids = root_ids(&snapshot.roots);
    let source = StructuralLocation {
        placeholder_block_id: None,
        ..target
    };
    snapshot.source = source.clone();
    refresh_snapshot_authorities(connection, &mut snapshot)?;
    let inverse = StructuralRecipeAction::DeleteActive {
        snapshot: snapshot.clone(),
        source,
        direction: deletion_direction,
    };
    let resume = restored_root_ids
        .first()
        .map(|block_id| LibraryEditorResumeTarget {
            block_id: block_id.clone(),
            edge: LibraryEditorResumeEdge::Start,
            fallback_before_block_id: None,
            fallback_after_block_id: None,
        });
    Ok(AppliedTransition {
        source_root_ids: root_ids(&snapshot.roots),
        result_root_ids: restored_root_ids,
        document_commits: vec![document_commit],
        inverse,
        snapshot,
        additional_snapshots: Vec::new(),
        resume,
        file_ownership_effects: PageFileOwnershipMoveEffects::default(),
    })
}

fn swap_active_with_deleted(
    write: StructuralWriteContext<'_>,
    active: OwnershipClosureSnapshot,
    deleted: OwnershipClosureSnapshot,
    direction: LibraryStructuralDeleteDirection,
) -> Result<AppliedTransition, StoreError> {
    let StructuralWriteContext {
        connection,
        context,
        ..
    } = write;
    if active.source.document_id != deleted.source.document_id {
        return Err(conflict(
            "Structural replacement history crossed Document authority",
        ));
    }
    let mut parent = load_parent_document(connection, &active.source.document_id)?;
    authorize_parent_write(connection, context, &parent)?;
    let removed = delete_snapshot(write, &mut parent, active, direction)?;
    let mut target = deleted.source.clone();
    target.placeholder_block_id = removed.snapshot.source.placeholder_block_id.clone();
    let mut current_parent = load_parent_document(connection, &target.document_id)?;
    authorize_parent_write(connection, context, &current_parent)?;
    let mut restored = restore_snapshot(write, &mut current_parent, deleted, target, direction)?;
    let removed_snapshot = removed.snapshot;
    let restored_snapshot = restored.snapshot.clone();
    restored.source_root_ids = root_ids(&removed_snapshot.roots);
    restored
        .document_commits
        .splice(0..0, removed.document_commits);
    restored.inverse = StructuralRecipeAction::SwapActiveWithDeleted {
        active: restored_snapshot,
        deleted: removed_snapshot.clone(),
        direction,
    };
    restored.additional_snapshots.push(removed_snapshot);
    Ok(restored)
}

fn validate_snapshot_authorities(
    connection: &Connection,
    snapshot: &OwnershipClosureSnapshot,
    expected_lifecycle: &str,
) -> Result<(), StoreError> {
    validate_snapshot_authorities_with_lifecycle(connection, snapshot, Some(expected_lifecycle))
}

fn validate_snapshot_authorities_exact(
    connection: &Connection,
    snapshot: &OwnershipClosureSnapshot,
) -> Result<(), StoreError> {
    validate_snapshot_authorities_with_lifecycle(connection, snapshot, None)
}

fn validate_snapshot_authorities_with_lifecycle(
    connection: &Connection,
    snapshot: &OwnershipClosureSnapshot,
    expected_lifecycle: Option<&str>,
) -> Result<(), StoreError> {
    for block in &snapshot.blocks {
        let current = connection
            .query_row(
                "SELECT lifecycle, metadata_revision, placement_revision FROM blocks \
                 WHERE id = ?1",
                [&block.block_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| conflict("Structural history Block no longer exists"))?;
        if expected_lifecycle.is_some_and(|expected| current.0 != expected)
            || current.0 != block.lifecycle
            || current.1 != block.metadata_revision
            || current.2 != block.placement_revision
        {
            return Err(conflict(
                "Structural ownership closure changed before the operation",
            ));
        }
    }
    for document in &snapshot.documents {
        let current = connection
            .query_row(
                "SELECT generation, head_seq FROM documents WHERE id = ?1",
                [&document.document_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?
            .ok_or_else(|| conflict("Structural owned Document no longer exists"))?;
        if current != (document.generation, document.head_seq) {
            return Err(conflict(
                "Structural owned Document changed before the operation",
            ));
        }
    }
    for database in &snapshot.databases {
        let current = connection
            .query_row(
                "SELECT lifecycle, metadata_revision FROM database_containers \
                 WHERE block_id = ?1",
                [&database.block_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?
            .ok_or_else(|| conflict("Structural Database authority no longer exists"))?;
        if expected_lifecycle.is_some_and(|expected| current.0 != expected)
            || current.0 != database.lifecycle
            || current.1 != database.metadata_revision
        {
            return Err(conflict(
                "Structural Database authority changed before the operation",
            ));
        }
        for source in &database.sources {
            let current = connection
                .query_row(
                    "SELECT schema_revision, lifecycle FROM data_sources WHERE id = ?1",
                    [&source.source_id],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?
                .ok_or_else(|| conflict("Structural Data Source no longer exists"))?;
            if current != (source.schema_revision, "active".to_owned()) {
                return Err(conflict("Structural Data Source schema changed"));
            }
        }
        for property in &database.properties {
            let current = connection
                .query_row(
                    "SELECT schema_revision, lifecycle FROM data_source_properties \
                     WHERE data_source_id = ?1 AND id = ?2",
                    params![property.source_id, property.property_id],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?
                .ok_or_else(|| conflict("Structural Database Property no longer exists"))?;
            if current != (property.schema_revision, property.lifecycle.clone()) {
                return Err(conflict("Structural Database Property changed"));
            }
        }
        for view in &database.views {
            let current = connection
                .query_row(
                    "SELECT revision, lifecycle FROM database_views WHERE id = ?1",
                    [&view.view_id],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?
                .ok_or_else(|| conflict("Structural Database View no longer exists"))?;
            if current != (view.revision, view.lifecycle.clone()) {
                return Err(conflict("Structural Database View changed"));
            }
        }
        for row in &database.rows {
            let current = connection
                .query_row(
                    "SELECT revision FROM data_source_page_memberships \
                     WHERE id = ?1 AND data_source_id = ?2 AND page_block_id = ?3 \
                       AND removed_at IS NULL",
                    params![row.membership_id, row.source_id, row.page_id],
                    |stored| stored.get::<_, i64>(0),
                )
                .optional()?
                .ok_or_else(|| conflict("Structural Database row membership changed"))?;
            if current != row.revision {
                return Err(conflict("Structural Database row membership changed"));
            }
            for value in &row.property_values {
                let current = connection
                    .query_row(
                        "SELECT revision, value_type, value_json \
                         FROM data_source_property_values \
                         WHERE data_source_id = ?1 AND membership_id = ?2 AND property_id = ?3",
                        params![row.source_id, row.membership_id, value.property_id],
                        |stored| {
                            Ok((
                                stored.get::<_, i64>(0)?,
                                stored.get::<_, String>(1)?,
                                stored.get::<_, String>(2)?,
                            ))
                        },
                    )
                    .optional()?
                    .ok_or_else(|| conflict("Structural Database row value changed"))?;
                if current
                    != (
                        value.revision,
                        value.value_type.clone(),
                        value.value_json.clone(),
                    )
                {
                    return Err(conflict("Structural Database row value changed"));
                }
            }
            for position in &row.view_positions {
                let current = connection
                    .query_row(
                        "SELECT revision, rank_key FROM database_view_page_positions \
                         WHERE view_id = ?1 AND page_block_id = ?2",
                        params![position.view_id, row.page_id],
                        |stored| Ok((stored.get::<_, i64>(0)?, stored.get::<_, String>(1)?)),
                    )
                    .optional()?
                    .ok_or_else(|| conflict("Structural Database row position changed"))?;
                if current != (position.revision, position.rank_key.clone()) {
                    return Err(conflict("Structural Database row position changed"));
                }
            }
            for edge in &row.relation_edges {
                let current = connection
                    .query_row(
                        "SELECT property_id, target_page_block_id, sibling_rank \
                         FROM data_source_relation_edges WHERE edge_id = ?1 \
                           AND source_data_source_id = ?2 AND source_membership_id = ?3",
                        params![edge.edge_id, row.source_id, row.membership_id],
                        |stored| {
                            Ok((
                                stored.get::<_, String>(0)?,
                                stored.get::<_, String>(1)?,
                                stored.get::<_, Option<String>>(2)?,
                            ))
                        },
                    )
                    .optional()?
                    .ok_or_else(|| conflict("Structural Database relation edge changed"))?;
                if current
                    != (
                        edge.property_id.clone(),
                        edge.target_page_id.clone(),
                        edge.sibling_rank.clone(),
                    )
                {
                    return Err(conflict("Structural Database relation edge changed"));
                }
            }
        }
    }
    Ok(())
}

fn transition_closure_lifecycle(
    connection: &Connection,
    snapshot: &OwnershipClosureSnapshot,
    from: &str,
    to: &str,
    target_host_page_id: Option<&str>,
    defer_page_projection: bool,
) -> Result<(), StoreError> {
    let now = sqlite_now(connection)?;
    for block in &snapshot.blocks {
        let must_preapply = !block.in_host_document || is_typed_owner(&block.block_type);
        if !must_preapply {
            continue;
        }
        let placement_advance = i64::from(block.in_host_document);
        let changed = connection.execute(
            "UPDATE blocks SET lifecycle = ?1, metadata_revision = metadata_revision + 1, \
               placement_revision = placement_revision + ?2, updated_at = ?3 \
             WHERE id = ?4 AND lifecycle = ?5 AND metadata_revision = ?6 \
               AND placement_revision = ?7",
            params![
                to,
                placement_advance,
                now,
                block.block_id,
                from,
                block.metadata_revision,
                block.placement_revision,
            ],
        )?;
        if changed != 1 {
            return Err(conflict(
                "Structural Block changed during its lifecycle transition",
            ));
        }
    }
    for page in &snapshot.pages {
        let block = snapshot
            .blocks
            .iter()
            .find(|block| block.block_id == page.block_id)
            .ok_or_else(|| corrupt("Structural Page has no Block evidence"))?;
        if let Some(target_host_page_id) = target_host_page_id.filter(|_| block.in_host_document) {
            let changed = connection.execute(
                "UPDATE pages SET parent_kind = 'page', parent_id = ?1, updated_at = ?2 \
                 WHERE block_id = ?3",
                params![target_host_page_id, now, page.block_id],
            )?;
            if changed != 1 {
                return Err(corrupt("Structural Page parent authority disappeared"));
            }
        }
    }
    if !defer_page_projection {
        transition_page_projections(connection, snapshot, from, to, target_host_page_id)?;
    }
    for database in &snapshot.databases {
        let changed = connection.execute(
            "UPDATE database_containers SET lifecycle = ?1, metadata_revision = metadata_revision + 1, \
               updated_at = ?2 WHERE block_id = ?3 AND lifecycle = ?4 \
               AND metadata_revision = ?5",
            params![
                to,
                now,
                database.block_id,
                from,
                database.metadata_revision,
            ],
        )?;
        if changed != 1 {
            return Err(conflict(
                "Structural Database changed during lifecycle transition",
            ));
        }
    }
    Ok(())
}

fn transition_page_projections(
    connection: &Connection,
    snapshot: &OwnershipClosureSnapshot,
    from: &str,
    to: &str,
    target_host_page_id: Option<&str>,
) -> Result<(), StoreError> {
    let now = sqlite_now(connection)?;
    for page in &snapshot.pages {
        let block = snapshot
            .blocks
            .iter()
            .find(|block| block.block_id == page.block_id)
            .ok_or_else(|| corrupt("Structural Page has no Block evidence"))?;
        let metadata_revision = block.metadata_revision + 1;
        let placement_revision = block.placement_revision + i64::from(block.in_host_document);
        let changed = connection.execute(
            "UPDATE page_read_model SET lifecycle = ?1, metadata_revision = ?2, \
               placement_revision = ?3, parent_kind = CASE WHEN ?4 IS NULL THEN parent_kind ELSE 'page' END, \
               parent_id = COALESCE(?4, parent_id), updated_at = ?5 \
             WHERE page_block_id = ?6 AND lifecycle = ?7",
            params![
                to,
                metadata_revision,
                placement_revision,
                target_host_page_id.filter(|_| block.in_host_document),
                now,
                page.block_id,
                from,
            ],
        )?;
        if changed != 1 {
            return Err(corrupt(
                "Structural Page projection disappeared during lifecycle transition",
            ));
        }
        connection.execute(
            "UPDATE scheduled_page_index SET lifecycle = ?1, source_metadata_revision = ?2, \
               updated_at = ?3 WHERE page_block_id = ?4",
            params![to, metadata_revision, now, page.block_id],
        )?;
    }
    Ok(())
}

fn refresh_snapshot_authorities(
    connection: &Connection,
    snapshot: &mut OwnershipClosureSnapshot,
) -> Result<(), StoreError> {
    for block in &mut snapshot.blocks {
        let current = connection.query_row(
            "SELECT lifecycle, metadata_revision, placement_revision FROM blocks WHERE id = ?1",
            [&block.block_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )?;
        block.lifecycle = current.0;
        block.metadata_revision = current.1;
        block.placement_revision = current.2;
        if block.in_host_document {
            block.containing_document_id = snapshot.source.document_id.clone();
        }
    }
    for document in &mut snapshot.documents {
        let current = connection.query_row(
            "SELECT generation, head_seq FROM documents WHERE id = ?1",
            [&document.document_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )?;
        document.generation = current.0;
        document.head_seq = current.1;
    }
    for database in &mut snapshot.databases {
        let current = connection.query_row(
            "SELECT lifecycle, metadata_revision FROM database_containers WHERE block_id = ?1",
            [&database.block_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )?;
        database.lifecycle = current.0;
        database.metadata_revision = current.1;
    }
    Ok(())
}

fn validate_restore_target(
    parent: &ResolvedParentDocument,
    snapshot: &OwnershipClosureSnapshot,
    target: &StructuralLocation,
) -> Result<(), StoreError> {
    if parent.authority.head.id != target.document_id
        || parent.authority.head.generation != target.document_generation
    {
        return Err(conflict("Structural restore target Document changed"));
    }
    validate_insertion_anchor(
        &parent.base_materialization.block_tree,
        target
            .placements
            .first()
            .and_then(|placement| placement.parent_block_id.as_deref()),
        target
            .placements
            .first()
            .and_then(|placement| placement.before_block_id.as_deref()),
    )?;
    if snapshot
        .roots
        .iter()
        .any(|root| find_block(&parent.base_materialization.block_tree, &root.id).is_some())
    {
        return Err(conflict("Structural restore root is already present"));
    }
    Ok(())
}

fn validate_empty_placeholder(
    parent: &ResolvedParentDocument,
    placeholder_id: &str,
) -> Result<(), StoreError> {
    let Some(placeholder) = find_block(&parent.base_materialization.block_tree, placeholder_id)
    else {
        return Err(conflict(
            "Structural restore placeholder is no longer present",
        ));
    };
    if placeholder != &empty_paragraph(placeholder_id) {
        return Err(conflict(
            "Structural restore placeholder contains newer content",
        ));
    }
    Ok(())
}

fn document_would_be_empty(tree: &[MaterializedBlockNode], root_ids: &[String]) -> bool {
    let roots = root_ids.iter().map(String::as_str).collect::<HashSet<_>>();
    !tree.is_empty() && tree.iter().all(|block| roots.contains(block.id.as_str()))
}

fn empty_paragraph(block_id: &str) -> MaterializedBlockNode {
    MaterializedBlockNode {
        id: block_id.to_owned(),
        block_type: "paragraph".to_owned(),
        props: BTreeMap::new(),
        content: Some(serde_json::Value::Array(Vec::new())),
        children: Vec::new(),
    }
}

fn deletion_resume_target(
    tree: &[MaterializedBlockNode],
    snapshot: &OwnershipClosureSnapshot,
    placeholder_id: Option<&str>,
    direction: LibraryStructuralDeleteDirection,
) -> Option<LibraryEditorResumeTarget> {
    if let Some(placeholder_id) = placeholder_id {
        return Some(LibraryEditorResumeTarget {
            block_id: placeholder_id.to_owned(),
            edge: LibraryEditorResumeEdge::Start,
            fallback_before_block_id: None,
            fallback_after_block_id: None,
        });
    }
    let selected = snapshot
        .blocks
        .iter()
        .filter(|block| block.in_host_document)
        .map(|block| block.block_id.as_str())
        .collect::<HashSet<_>>();
    let flat = flatten_blocks(tree);
    let first = flat
        .iter()
        .position(|block| selected.contains(block.id.as_str()))?;
    let last = flat
        .iter()
        .rposition(|block| selected.contains(block.id.as_str()))?;
    let previous = flat[..first]
        .iter()
        .rev()
        .find(|block| !selected.contains(block.id.as_str()));
    let next = flat[last + 1..]
        .iter()
        .find(|block| !selected.contains(block.id.as_str()));
    let preferred = match direction {
        LibraryStructuralDeleteDirection::Backward => previous.or(next),
        LibraryStructuralDeleteDirection::Forward => next.or(previous),
    };
    preferred.map(|block| LibraryEditorResumeTarget {
        block_id: block.id.clone(),
        edge: if previous.is_some_and(|previous| previous.id == block.id) {
            LibraryEditorResumeEdge::End
        } else {
            LibraryEditorResumeEdge::Start
        },
        fallback_before_block_id: previous.map(|block| block.id.clone()),
        fallback_after_block_id: next.map(|block| block.id.clone()),
    })
}

fn is_typed_owner(block_type: &str) -> bool {
    TYPED_OWNER_TYPES.contains(&block_type)
}

fn validate_restore_target_for_move(
    parent: &ResolvedParentDocument,
    snapshot: &OwnershipClosureSnapshot,
    target: &StructuralLocation,
) -> Result<(), StoreError> {
    if parent.authority.head.id != target.document_id
        || parent.authority.head.generation != target.document_generation
    {
        return Err(conflict("Structural move target Document changed"));
    }
    for placement in &target.placements {
        let parent_id = placement.parent_block_id.as_deref();
        let before_id = placement.before_block_id.as_deref();
        validate_insertion_anchor_for_move(
            &parent.base_materialization.block_tree,
            parent_id,
            before_id,
            snapshot,
        )?;
    }
    Ok(())
}

fn validate_insertion_anchor_for_move(
    tree: &[MaterializedBlockNode],
    parent_id: Option<&str>,
    before_id: Option<&str>,
    snapshot: &OwnershipClosureSnapshot,
) -> Result<(), StoreError> {
    let moved = snapshot
        .blocks
        .iter()
        .filter(|block| block.in_host_document)
        .map(|block| block.block_id.as_str())
        .collect::<HashSet<_>>();
    if parent_id.is_some_and(|id| moved.contains(id))
        || before_id.is_some_and(|id| moved.contains(id))
    {
        return Err(conflict(
            "Structural move destination is inside the moved selection",
        ));
    }
    validate_insertion_anchor(tree, parent_id, before_id)
}

fn update_host_page_parent_authorities(
    connection: &Connection,
    snapshot: &OwnershipClosureSnapshot,
    target_host_page_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    for page in &snapshot.pages {
        let Some(block) = snapshot
            .blocks
            .iter()
            .find(|block| block.block_id == page.block_id)
        else {
            return Err(corrupt("Structural Page has no Block evidence"));
        };
        if !block.in_host_document {
            continue;
        }
        let changed = connection.execute(
            "UPDATE pages SET parent_kind = 'page', parent_id = ?1, updated_at = ?2 \
             WHERE block_id = ?3",
            params![target_host_page_id, now, page.block_id],
        )?;
        if changed != 1 {
            return Err(corrupt(
                "Structural Page parent authority disappeared during move",
            ));
        }
    }
    Ok(())
}

fn update_host_page_parent_projections(
    connection: &Connection,
    snapshot: &OwnershipClosureSnapshot,
    target_host_page_id: &str,
    now: &str,
) -> Result<(), StoreError> {
    for page in &snapshot.pages {
        let Some(block) = snapshot
            .blocks
            .iter()
            .find(|block| block.block_id == page.block_id)
        else {
            return Err(corrupt("Structural Page has no Block evidence"));
        };
        if !block.in_host_document {
            continue;
        }
        let (placement_revision, metadata_revision) = connection.query_row(
            "SELECT placement_revision, metadata_revision FROM blocks WHERE id = ?1",
            [&page.block_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )?;
        let changed = connection.execute(
            "UPDATE page_read_model SET parent_kind = 'page', parent_id = ?1, \
               placement_revision = ?2, metadata_revision = ?3, updated_at = ?4 \
             WHERE page_block_id = ?5",
            params![
                target_host_page_id,
                placement_revision,
                metadata_revision,
                now,
                page.block_id,
            ],
        )?;
        if changed != 1 {
            return Err(corrupt(
                "Structural Page parent projection disappeared during move",
            ));
        }
    }
    Ok(())
}

fn move_active_snapshot(
    write: StructuralWriteContext<'_>,
    mut snapshot: OwnershipClosureSnapshot,
    source: StructuralLocation,
    target: StructuralLocation,
) -> Result<AppliedTransition, StoreError> {
    let StructuralWriteContext {
        connection,
        context,
        operation_id,
        store_epoch,
        commit,
    } = write;
    let source_parent = load_parent_document(connection, &source.document_id)?;
    authorize_parent_write(connection, context, &source_parent)?;
    validate_snapshot_is_at_location(&source_parent, &snapshot, &source)?;
    validate_snapshot_authorities(connection, &snapshot, "active")?;
    if source.document_id == target.document_id {
        validate_restore_target_for_move(&source_parent, &snapshot, &target)?;
        let mut operations = Vec::new();
        if let Some(placeholder_id) = &target.placeholder_block_id {
            validate_empty_placeholder(&source_parent, placeholder_id)?;
            operations.push(DocumentBlockOperation::DeleteBlock {
                block_id: placeholder_id.clone(),
            });
        }
        for placement in &target.placements {
            operations.push(DocumentBlockOperation::MoveBlock {
                block_id: placement.block_id.clone(),
                parent_block_id: placement.parent_block_id.clone(),
                before_block_id: placement.before_block_id.clone(),
            });
        }
        let document_commit = persist_parent_operations_detailed_with_local_commit(
            connection,
            ParentDocumentWriteContext {
                actor_project_id: bound_project_id(context)?,
                store_epoch,
                operation_id,
                commit,
            },
            "structural-move",
            &source_parent,
            &operations,
            ParentDocumentPlacement::Derived {
                attachment_advances: &[],
            },
        )?;
        let current = StructuralLocation {
            placeholder_block_id: None,
            ..target.clone()
        };
        snapshot.source = current.clone();
        refresh_snapshot_authorities(connection, &mut snapshot)?;
        let inverse = StructuralRecipeAction::MoveActive {
            snapshot: snapshot.clone(),
            source: current,
            target: source,
        };
        return Ok(AppliedTransition {
            source_root_ids: root_ids(&snapshot.roots),
            result_root_ids: root_ids(&snapshot.roots),
            document_commits: vec![document_commit],
            inverse,
            snapshot,
            additional_snapshots: Vec::new(),
            resume: None,
            file_ownership_effects: PageFileOwnershipMoveEffects::default(),
        });
    }

    let target_parent = load_parent_document(connection, &target.document_id)?;
    authorize_parent_write(connection, context, &target_parent)?;
    validate_restore_target_for_move(&target_parent, &snapshot, &target)?;
    let root_block_ids = root_ids(&snapshot.roots);
    let source_placeholder = document_would_be_empty(
        &source_parent.base_materialization.block_tree,
        &root_block_ids,
    )
    .then(|| {
        stable_uuid_v7(
            operation_id,
            "structural_move_placeholder",
            &source.document_id,
        )
    });
    let mut source_operations = root_block_ids
        .iter()
        .map(|block_id| DocumentBlockOperation::DeleteBlock {
            block_id: block_id.clone(),
        })
        .collect::<Vec<_>>();
    if let Some(placeholder_id) = &source_placeholder {
        source_operations.push(DocumentBlockOperation::InsertBlock {
            block: empty_paragraph(placeholder_id),
            parent_block_id: None,
            before_block_id: None,
        });
    }
    let relocated_block_ids = snapshot
        .blocks
        .iter()
        .filter(|block| block.in_host_document)
        .map(|block| block.block_id.clone())
        .collect::<Vec<_>>();
    let candidate_file_ids = snapshot.host_page_file_ids.clone();
    let source_commit = persist_parent_relocation_source_with_placeholder(
        connection,
        ParentDocumentWriteContext {
            actor_project_id: bound_project_id(context)?,
            store_epoch,
            operation_id,
            commit,
        },
        "structural-move-source",
        &source_parent,
        &source_operations,
        &relocated_block_ids,
    )?;
    let moved_at = sqlite_now(connection)?;
    update_host_page_parent_authorities(connection, &snapshot, &target.host_page_id, &moved_at)?;
    let mut target_operations = Vec::new();
    if let Some(placeholder_id) = &target.placeholder_block_id {
        validate_empty_placeholder(&target_parent, placeholder_id)?;
        target_operations.push(DocumentBlockOperation::DeleteBlock {
            block_id: placeholder_id.clone(),
        });
    }
    for root in &snapshot.roots {
        let placement = target
            .placements
            .iter()
            .find(|placement| placement.block_id == root.id)
            .ok_or_else(|| corrupt("Structural move placement is incomplete"))?;
        target_operations.push(DocumentBlockOperation::InsertBlock {
            block: root.clone(),
            parent_block_id: placement.parent_block_id.clone(),
            before_block_id: placement.before_block_id.clone(),
        });
    }
    let target_commit = persist_parent_operations_detailed_with_local_commit(
        connection,
        ParentDocumentWriteContext {
            actor_project_id: bound_project_id(context)?,
            store_epoch,
            operation_id,
            commit,
        },
        "structural-move-target",
        &target_parent,
        &target_operations,
        ParentDocumentPlacement::Derived {
            attachment_advances: &relocated_block_ids,
        },
    )?;
    let file_ownership_effects = move_exclusively_placed_files(
        connection,
        &source_parent.authority.head.library_id,
        operation_id,
        bound_project_id(context)?,
        &moved_at,
        &[PageFilePlacementMove {
            source_page_id: source.host_page_id.clone(),
            target_page_id: target.host_page_id.clone(),
            candidate_file_ids,
        }],
    )?;
    update_host_page_parent_projections(connection, &snapshot, &target.host_page_id, &moved_at)?;
    let current = StructuralLocation {
        placeholder_block_id: None,
        ..target.clone()
    };
    let return_target = StructuralLocation {
        placeholder_block_id: source_placeholder,
        ..source
    };
    snapshot.source = current.clone();
    refresh_snapshot_authorities(connection, &mut snapshot)?;
    let inverse = StructuralRecipeAction::MoveActive {
        snapshot: snapshot.clone(),
        source: current,
        target: return_target,
    };
    Ok(AppliedTransition {
        source_root_ids: root_ids(&snapshot.roots),
        result_root_ids: root_block_ids,
        document_commits: vec![source_commit, target_commit],
        inverse,
        snapshot,
        additional_snapshots: Vec::new(),
        resume: None,
        file_ownership_effects,
    })
}

#[allow(clippy::too_many_arguments)]
fn clone_snapshot_into_target(
    connection: &Connection,
    context: &BoundModuleContext,
    operation_id: &str,
    store_epoch: &str,
    commit: &crate::infrastructure::local_commit::CommitContext,
    parent: &mut ResolvedParentDocument,
    snapshot: &OwnershipClosureSnapshot,
    target: StructuralLocation,
    assets_root: &Path,
    now: &str,
) -> Result<CloneTransition, StoreError> {
    let block_ids = snapshot
        .blocks
        .iter()
        .map(|block| {
            (
                block.block_id.clone(),
                stable_uuid_v7(operation_id, "structural_block", &block.block_id),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let document_ids = snapshot
        .documents
        .iter()
        .map(|document| {
            (
                document.document_id.clone(),
                stable_uuid_v7(operation_id, "structural_document", &document.document_id),
            )
        })
        .collect::<BTreeMap<_, _>>();
    assert_fresh_clone_identities(connection, &block_ids, &document_ids)?;
    let data_source_ids = snapshot
        .databases
        .iter()
        .flat_map(|database| &database.sources)
        .map(|source| {
            (
                source.source_id.clone(),
                stable_uuid_v7(operation_id, "structural_data_source", &source.source_id),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let view_ids = snapshot
        .databases
        .iter()
        .flat_map(|database| &database.views)
        .map(|view| {
            (
                view.view_id.clone(),
                stable_uuid_v7(operation_id, "structural_view", &view.view_id),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let membership_ids = snapshot
        .databases
        .iter()
        .flat_map(|database| &database.rows)
        .map(|row| {
            (
                row.membership_id.clone(),
                stable_uuid_v7(
                    operation_id,
                    "structural_database_membership",
                    &row.membership_id,
                ),
            )
        })
        .collect::<BTreeMap<_, _>>();
    assert_fresh_auxiliary_identities(connection, &data_source_ids, &view_ids)?;
    stage_clone_authority(
        connection,
        snapshot,
        &block_ids,
        &document_ids,
        &data_source_ids,
        &view_ids,
        &membership_ids,
        &target,
        now,
    )?;
    let mut document_commits = Vec::new();
    for document in &snapshot.documents {
        let target_document_id = mapped(&document_ids, &document.document_id, "Document")?;
        let target_authority = read_document_authority(connection, target_document_id)?
            .ok_or_else(|| corrupt("Cloned owned Document authority disappeared"))?;
        match &document.body {
            OwnedDocumentBody::Yjs { rich_title, blocks } => {
                let schema = crate::document::BlockDocumentSchema::from_identity(
                    &document.schema_key,
                    document.schema_version,
                )
                .ok_or_else(|| unsupported("Cloned owned Document schema is unsupported"))?;
                let title = if document.owner_type == "page"
                    && snapshot
                        .roots
                        .iter()
                        .any(|root| root.id == document.owner_block_id)
                {
                    duplicate_rich_title(rich_title)
                } else {
                    rich_title.clone()
                };
                let title_delta = if title.is_empty() {
                    None
                } else {
                    Some(
                        crate::domain::rich_text::rich_text_to_delta(&title).map_err(|error| {
                            invalid(format!("Cloned title is invalid: {error}"))
                        })?,
                    )
                };
                let cloned_blocks = remap_materialized_blocks(blocks, &block_ids)?;
                let prepared = prepare_yjs_clone_genesis(
                    target_document_id,
                    &document.owner_type,
                    schema,
                    title_delta.as_deref(),
                    &cloned_blocks,
                )?;
                let typed_genesis = snapshot
                    .blocks
                    .iter()
                    .filter(|block| {
                        block.containing_document_id == document.document_id
                            && is_typed_owner(&block.block_type)
                    })
                    .map(|block| mapped(&block_ids, &block.block_id, "Block").cloned())
                    .collect::<Result<Vec<_>, _>>()?;
                let update_id = format!(
                    "library-structural-clone:{}:{}",
                    sha256(operation_id.as_bytes()),
                    sha256(document.document_id.as_bytes()),
                );
                let full_state = prepared.engine.full_state_v1();
                let persisted = persist_yjs_genesis_with_local_commit(
                    connection,
                    PersistYjsGenesis {
                        authority: &target_authority,
                        actor_project_id: bound_project_id(context)?,
                        materialization: &prepared.materialization,
                        update_id: &update_id,
                        client_session_id: "library-structural-edit",
                        update: &prepared.update_v1,
                        state_vector: &prepared.state_vector_v1,
                        full_state: &full_state,
                        store_epoch,
                        operation_id: &update_id,
                        placement: DocumentPlacementEvidence::STRUCTURAL
                            .with_genesis(&typed_genesis),
                        emit_event: false,
                    },
                    commit,
                )?;
                document_commits.push(LibraryBlockTransferDocumentCommit {
                    document_id: target_document_id.clone(),
                    generation: target_authority.head.generation,
                    base_head_seq: 0,
                    head_seq: persisted.head_seq,
                    update_id,
                    update: prepared.update_v1,
                    state_vector: persisted.state_vector,
                });
                if document.owner_type == "page" {
                    let page_id = mapped(&block_ids, &document.owner_block_id, "Page")?;
                    insert_page_read_model(
                        connection,
                        page_id,
                        &prepared.materialization,
                        persisted.head_seq,
                        now,
                    )?;
                    ensure_default_page_intrinsic_properties(connection, page_id, now)?;
                    refresh_page_intrinsic_projection(connection, page_id, now)?;
                }
            }
            OwnedDocumentBody::Canvas { scene } => {
                clone_canvas_scene_genesis(
                    connection,
                    scene.clone(),
                    &target_authority,
                    assets_root,
                )?;
            }
        }
    }
    refresh_cloned_database_row_projections(
        connection,
        snapshot,
        &block_ids,
        &data_source_ids,
        &view_ids,
        &membership_ids,
        now,
    )?;
    let cloned_roots = remap_materialized_blocks(&snapshot.roots, &block_ids)?;
    let mapped_target = remap_location(&target, &block_ids)?;
    let operations = cloned_roots
        .iter()
        .map(|root| {
            let placement = mapped_target
                .placements
                .iter()
                .find(|placement| placement.block_id == root.id)
                .ok_or_else(|| corrupt("Cloned root placement is missing"))?;
            Ok(DocumentBlockOperation::InsertBlock {
                block: root.clone(),
                parent_block_id: placement.parent_block_id.clone(),
                before_block_id: placement.before_block_id.clone(),
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    let host_typed_genesis = snapshot
        .blocks
        .iter()
        .filter(|block| block.in_host_document && is_typed_owner(&block.block_type))
        .map(|block| mapped(&block_ids, &block.block_id, "Block").cloned())
        .collect::<Result<Vec<_>, _>>()?;
    let host_commit = persist_parent_operations_detailed_with_local_commit(
        connection,
        ParentDocumentWriteContext {
            actor_project_id: bound_project_id(context)?,
            store_epoch,
            operation_id,
            commit,
        },
        "structural-clone-target",
        parent,
        &operations,
        ParentDocumentPlacement::Genesis(&host_typed_genesis),
    )?;
    document_commits.push(host_commit);
    let mut cloned_snapshot = remap_snapshot(
        snapshot,
        &block_ids,
        &document_ids,
        &data_source_ids,
        &view_ids,
        &membership_ids,
        mapped_target.clone(),
    )?;
    refresh_snapshot_authorities(connection, &mut cloned_snapshot)?;
    let inverse = StructuralRecipeAction::DeleteActive {
        snapshot: cloned_snapshot.clone(),
        source: mapped_target,
        direction: LibraryStructuralDeleteDirection::Backward,
    };
    Ok((
        AppliedTransition {
            source_root_ids: root_ids(&snapshot.roots),
            result_root_ids: root_ids(&cloned_roots),
            document_commits,
            inverse,
            snapshot: cloned_snapshot,
            additional_snapshots: Vec::new(),
            resume: None,
            file_ownership_effects: PageFileOwnershipMoveEffects::default(),
        },
        block_ids,
        document_ids,
        Vec::new(),
    ))
}

#[allow(clippy::too_many_arguments)]
fn stage_clone_authority(
    connection: &Connection,
    snapshot: &OwnershipClosureSnapshot,
    block_ids: &BTreeMap<String, String>,
    document_ids: &BTreeMap<String, String>,
    data_source_ids: &BTreeMap<String, String>,
    view_ids: &BTreeMap<String, String>,
    membership_ids: &BTreeMap<String, String>,
    target: &StructuralLocation,
    now: &str,
) -> Result<(), StoreError> {
    let library_id = connection.query_row(
        "SELECT library_id FROM documents WHERE id = ?1",
        [&target.document_id],
        |row| row.get::<_, String>(0),
    )?;
    for document in &snapshot.documents {
        let target_document_id = mapped(document_ids, &document.document_id, "Document")?;
        let canvas = matches!(document.body, OwnedDocumentBody::Canvas { .. });
        connection.execute(
            "INSERT INTO documents( \
               id, library_id, generation, head_seq, schema_key, schema_version, state_vector, \
               state_hash, readiness, authority, created_at, updated_at, sync_engine \
             ) VALUES (?1, ?2, 1, 0, ?3, ?4, X'', ?5, ?6, ?7, ?8, ?8, ?9)",
            params![
                target_document_id,
                library_id,
                document.schema_key,
                document.schema_version,
                if canvas {
                    "0".repeat(64)
                } else {
                    String::new()
                },
                if canvas { "ready" } else { "pending_genesis" },
                if canvas {
                    "ydoc_primary"
                } else {
                    "legacy_shadow"
                },
                now,
                if canvas { "canvas_scene" } else { "yjs" },
            ],
        )?;
    }
    for block in snapshot
        .blocks
        .iter()
        .filter(|block| is_typed_owner(&block.block_type))
    {
        connection.execute(
            "INSERT INTO blocks( \
               id, library_id, type, lifecycle, placement_revision, metadata_revision, \
               created_at, updated_at \
             ) VALUES (?1, ?2, ?3, 'active', 1, 1, ?4, ?4)",
            params![
                mapped(block_ids, &block.block_id, "Block")?,
                library_id,
                block.block_type,
                now,
            ],
        )?;
    }
    for document in &snapshot.documents {
        connection.execute(
            "INSERT INTO block_documents(block_id, document_id, library_id, created_at) \
             VALUES (?1, ?2, ?3, ?4)",
            params![
                mapped(block_ids, &document.owner_block_id, "Document owner")?,
                mapped(document_ids, &document.document_id, "Document")?,
                library_id,
                now,
            ],
        )?;
    }
    for page in &snapshot.pages {
        let source_block = snapshot
            .blocks
            .iter()
            .find(|block| block.block_id == page.block_id)
            .ok_or_else(|| corrupt("Cloned Page has no Block evidence"))?;
        let (parent_kind, parent_id) = if page.parent_kind == "data_source" {
            (
                "data_source",
                mapped(data_source_ids, &page.parent_id, "Data Source")?.clone(),
            )
        } else if source_block.in_host_document {
            ("page", target.host_page_id.clone())
        } else {
            let containing = snapshot
                .documents
                .iter()
                .find(|document| document.document_id == source_block.containing_document_id)
                .ok_or_else(|| corrupt("Nested cloned Page has no containing Document"))?;
            (
                "page",
                mapped(block_ids, &containing.owner_block_id, "Parent Page")?.clone(),
            )
        };
        let page_id = mapped(block_ids, &page.block_id, "Page")?;
        connection.execute(
            "INSERT INTO pages( \
               block_id, library_id, document_id, parent_kind, parent_id, created_at, updated_at \
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![
                page_id,
                library_id,
                mapped(document_ids, &page.document_id, "Page Document")?,
                parent_kind,
                parent_id,
                now,
            ],
        )?;
        for property in &page.properties {
            connection.execute(
                "INSERT INTO block_properties( \
                   block_id, library_id, property_key, value_type, value_json, revision, updated_at \
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
                params![
                    page_id,
                    library_id,
                    property.property_key,
                    property.value_type,
                    property.value_json,
                    now,
                ],
            )?;
        }
    }
    for document in snapshot
        .documents
        .iter()
        .filter(|document| document.owner_type == "canvas")
    {
        connection.execute(
            "INSERT INTO canvas_owners(block_id, library_id, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?3)",
            params![
                mapped(block_ids, &document.owner_block_id, "Canvas")?,
                library_id,
                now,
            ],
        )?;
    }
    for database in &snapshot.databases {
        stage_database_clone(
            connection,
            &library_id,
            database,
            block_ids,
            data_source_ids,
            view_ids,
            membership_ids,
            snapshot
                .roots
                .iter()
                .any(|root| root.id == database.block_id),
            now,
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn stage_database_clone(
    connection: &Connection,
    library_id: &str,
    database: &DatabaseAuthoritySnapshot,
    block_ids: &BTreeMap<String, String>,
    data_source_ids: &BTreeMap<String, String>,
    view_ids: &BTreeMap<String, String>,
    membership_ids: &BTreeMap<String, String>,
    duplicate_title: bool,
    now: &str,
) -> Result<(), StoreError> {
    let database_id = mapped(block_ids, &database.block_id, "Database")?;
    let default_view_id = database
        .default_view_id
        .as_ref()
        .map(|view_id| mapped(view_ids, view_id, "Default View").cloned())
        .transpose()?;
    connection.execute(
        "INSERT INTO database_containers( \
           block_id, library_id, name, lifecycle, default_view_id, access_revision, \
           metadata_revision, created_at, updated_at \
         ) VALUES (?1, ?2, ?3, 'active', NULL, 1, 1, ?4, ?4)",
        params![
            database_id,
            library_id,
            if duplicate_title {
                duplicate_plain_title(&database.name)
            } else {
                database.name.clone()
            },
            now,
        ],
    )?;
    for source in &database.sources {
        connection.execute(
            "INSERT INTO data_sources( \
               id, library_id, home_database_block_id, name, schema_key, schema_revision, \
               lifecycle, rank_key, created_at, updated_at \
             ) VALUES (?1, ?2, ?3, ?4, ?5, 1, 'active', ?6, ?7, ?7)",
            params![
                mapped(data_source_ids, &source.source_id, "Data Source")?,
                library_id,
                database_id,
                source.name,
                source.schema_key,
                source.rank_key,
                now,
            ],
        )?;
    }
    for property in &database.properties {
        connection.execute(
            "INSERT INTO data_source_properties( \
               data_source_id, id, name, value_type, config_json, rank_key, lifecycle, \
               schema_revision, created_at, updated_at \
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)",
            params![
                mapped(data_source_ids, &property.source_id, "Data Source")?,
                property.property_id,
                property.name,
                property.value_type,
                property.config_json,
                property.rank_key,
                property.lifecycle,
                now,
            ],
        )?;
    }
    for relation in &database.relation_properties {
        let target_source_id = data_source_ids
            .get(&relation.target_source_id)
            .unwrap_or(&relation.target_source_id);
        connection.execute(
            "INSERT INTO data_source_relation_properties( \
               data_source_id, property_id, target_data_source_id, cardinality \
             ) VALUES (?1, ?2, ?3, ?4)",
            params![
                mapped(data_source_ids, &relation.source_id, "Data Source")?,
                relation.property_id,
                target_source_id,
                relation.cardinality,
            ],
        )?;
    }
    for view in &database.views {
        connection.execute(
            "INSERT INTO database_views( \
               id, database_block_id, data_source_id, name, default_layout, config_json, \
               revision, rank_key, lifecycle, created_at, updated_at \
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9, ?9)",
            params![
                mapped(view_ids, &view.view_id, "View")?,
                database_id,
                mapped(data_source_ids, &view.source_id, "Data Source")?,
                view.name,
                view.default_layout,
                view.config_json,
                view.rank_key,
                view.lifecycle,
                now,
            ],
        )?;
    }
    if let Some(default_view_id) = default_view_id {
        connection.execute(
            "UPDATE database_containers SET default_view_id = ?1 WHERE block_id = ?2",
            params![default_view_id, database_id],
        )?;
    }
    for row in &database.rows {
        let source_id = mapped(data_source_ids, &row.source_id, "Data Source")?;
        let membership_id = mapped(membership_ids, &row.membership_id, "Membership")?;
        let page_id = mapped(block_ids, &row.page_id, "Database row Page")?;
        connection.execute(
            "INSERT INTO data_source_page_memberships( \
               id, data_source_id, page_block_id, revision, created_at, removed_at, completed_at \
             ) VALUES (?1, ?2, ?3, 1, ?4, NULL, ?5)",
            params![membership_id, source_id, page_id, now, row.completed_at],
        )?;
        for value in &row.property_values {
            connection.execute(
                "INSERT INTO data_source_property_values( \
                   data_source_id, membership_id, property_id, value_type, value_json, \
                   revision, updated_at \
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
                params![
                    source_id,
                    membership_id,
                    value.property_id,
                    value.value_type,
                    value.value_json,
                    now,
                ],
            )?;
        }
        for position in &row.view_positions {
            connection.execute(
                "INSERT INTO database_view_page_positions( \
                   view_id, page_block_id, rank_key, revision, created_at, updated_at \
                 ) VALUES (?1, ?2, ?3, 1, ?4, ?4)",
                params![
                    mapped(view_ids, &position.view_id, "View")?,
                    page_id,
                    position.rank_key,
                    now,
                ],
            )?;
        }
        for edge in &row.relation_edges {
            let target_page_id = block_ids
                .get(&edge.target_page_id)
                .unwrap_or(&edge.target_page_id);
            let edge_id = sha256(format!("{membership_id}\0{}", edge.edge_id).as_bytes());
            connection.execute(
                "INSERT INTO data_source_relation_edges( \
                   edge_id, source_data_source_id, source_membership_id, property_id, \
                   target_page_block_id, created_at, sibling_rank \
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    edge_id,
                    source_id,
                    membership_id,
                    edge.property_id,
                    target_page_id,
                    now,
                    edge.sibling_rank,
                ],
            )?;
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn refresh_cloned_database_row_projections(
    connection: &Connection,
    snapshot: &OwnershipClosureSnapshot,
    block_ids: &BTreeMap<String, String>,
    data_source_ids: &BTreeMap<String, String>,
    view_ids: &BTreeMap<String, String>,
    membership_ids: &BTreeMap<String, String>,
    now: &str,
) -> Result<(), StoreError> {
    for database in &snapshot.databases {
        for row in &database.rows {
            let page_id = mapped(block_ids, &row.page_id, "Database row Page")?;
            let property_revisions = row
                .property_values
                .iter()
                .map(|value| (value.property_id.clone(), serde_json::Value::from(1)))
                .collect::<serde_json::Map<_, _>>();
            let current_revisions = connection.query_row(
                "SELECT property_revisions_json FROM page_read_model WHERE page_block_id = ?1",
                [page_id],
                |stored| stored.get::<_, String>(0),
            )?;
            let intrinsic_revisions = serde_json::from_str::<serde_json::Value>(&current_revisions)
                .ok()
                .and_then(|value| value.get("intrinsic").cloned())
                .filter(serde_json::Value::is_object)
                .unwrap_or_else(|| serde_json::json!({}));
            let revisions_json = canonical_json(
                &serde_json::json!({
                    "database": property_revisions,
                    "intrinsic": intrinsic_revisions,
                }),
                "Database row Property revisions",
            )?;
            let projected_view_id = row
                .projected_view_id
                .as_ref()
                .map(|view_id| mapped(view_ids, view_id, "View").cloned())
                .transpose()?;
            let changed = connection.execute(
                "UPDATE page_read_model SET membership_id = ?1, database_block_id = ?2, \
                   view_id = ?3, view_group_key = ?4, view_rank_key = ?5, \
                   database_values_json = ?6, property_revisions_json = ?7, updated_at = ?8 \
                 WHERE page_block_id = ?9",
                params![
                    mapped(membership_ids, &row.membership_id, "Membership")?,
                    mapped(block_ids, &database.block_id, "Database")?,
                    projected_view_id,
                    row.view_group_key,
                    row.view_rank_key,
                    row.database_values_json,
                    revisions_json,
                    now,
                    page_id,
                ],
            )?;
            if changed != 1 {
                return Err(corrupt("Cloned Database row projection disappeared"));
            }
            let expected_source = mapped(data_source_ids, &row.source_id, "Data Source")?;
            let actual_source = connection.query_row(
                "SELECT data_source_id FROM data_source_page_memberships WHERE id = ?1",
                [mapped(membership_ids, &row.membership_id, "Membership")?],
                |stored| stored.get::<_, String>(0),
            )?;
            if &actual_source != expected_source {
                return Err(corrupt("Cloned Database row membership source diverged"));
            }
        }
    }
    Ok(())
}

fn assert_fresh_clone_identities(
    connection: &Connection,
    block_ids: &BTreeMap<String, String>,
    document_ids: &BTreeMap<String, String>,
) -> Result<(), StoreError> {
    let mut allocated = BTreeSet::new();
    for identity in block_ids.values().chain(document_ids.values()) {
        if !allocated.insert(identity) {
            return Err(corrupt("Structural clone allocated a duplicate identity"));
        }
    }
    for identity in block_ids.values() {
        if connection
            .query_row("SELECT 1 FROM blocks WHERE id = ?1", [identity], |_| Ok(()))
            .optional()?
            .is_some()
        {
            return Err(conflict("Structural clone Block identity already exists"));
        }
    }
    for identity in document_ids.values() {
        if connection
            .query_row("SELECT 1 FROM documents WHERE id = ?1", [identity], |_| {
                Ok(())
            })
            .optional()?
            .is_some()
        {
            return Err(conflict(
                "Structural clone Document identity already exists",
            ));
        }
    }
    Ok(())
}

fn assert_fresh_auxiliary_identities(
    connection: &Connection,
    data_source_ids: &BTreeMap<String, String>,
    view_ids: &BTreeMap<String, String>,
) -> Result<(), StoreError> {
    for identity in data_source_ids.values() {
        if connection
            .query_row(
                "SELECT 1 FROM data_sources WHERE id = ?1",
                [identity],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
        {
            return Err(conflict(
                "Structural clone Data Source identity already exists",
            ));
        }
    }
    for identity in view_ids.values() {
        if connection
            .query_row(
                "SELECT 1 FROM database_views WHERE id = ?1",
                [identity],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
        {
            return Err(conflict("Structural clone View identity already exists"));
        }
    }
    Ok(())
}

fn mapped<'a>(
    mapping: &'a BTreeMap<String, String>,
    source_id: &str,
    label: &str,
) -> Result<&'a String, StoreError> {
    mapping
        .get(source_id)
        .ok_or_else(|| corrupt(format!("Structural clone omitted {label} identity")))
}

fn remap_materialized_blocks(
    blocks: &[MaterializedBlockNode],
    block_ids: &BTreeMap<String, String>,
) -> Result<Vec<MaterializedBlockNode>, StoreError> {
    blocks
        .iter()
        .map(|block| {
            Ok(MaterializedBlockNode {
                id: mapped(block_ids, &block.id, "Block")?.clone(),
                block_type: block.block_type.clone(),
                props: block.props.clone(),
                content: block.content.clone(),
                children: remap_materialized_blocks(&block.children, block_ids)?,
            })
        })
        .collect()
}

fn remap_location(
    location: &StructuralLocation,
    block_ids: &BTreeMap<String, String>,
) -> Result<StructuralLocation, StoreError> {
    Ok(StructuralLocation {
        document_id: location.document_id.clone(),
        document_generation: location.document_generation,
        host_page_id: location.host_page_id.clone(),
        placements: location
            .placements
            .iter()
            .map(|placement| {
                Ok(RootPlacement {
                    block_id: mapped(block_ids, &placement.block_id, "Root Block")?.clone(),
                    parent_block_id: placement.parent_block_id.clone(),
                    before_block_id: placement.before_block_id.clone(),
                })
            })
            .collect::<Result<Vec<_>, StoreError>>()?,
        placeholder_block_id: location.placeholder_block_id.clone(),
    })
}

#[allow(clippy::too_many_arguments)]
fn remap_snapshot(
    snapshot: &OwnershipClosureSnapshot,
    block_ids: &BTreeMap<String, String>,
    document_ids: &BTreeMap<String, String>,
    data_source_ids: &BTreeMap<String, String>,
    view_ids: &BTreeMap<String, String>,
    membership_ids: &BTreeMap<String, String>,
    source: StructuralLocation,
) -> Result<OwnershipClosureSnapshot, StoreError> {
    let blocks = snapshot
        .blocks
        .iter()
        .map(|block| {
            Ok(BlockAuthoritySnapshot {
                block_id: mapped(block_ids, &block.block_id, "Block")?.clone(),
                block_type: block.block_type.clone(),
                lifecycle: "active".to_owned(),
                metadata_revision: 1,
                placement_revision: 1,
                containing_document_id: if block.in_host_document {
                    source.document_id.clone()
                } else {
                    mapped(
                        document_ids,
                        &block.containing_document_id,
                        "Containing Document",
                    )?
                    .clone()
                },
                in_host_document: block.in_host_document,
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    let documents = snapshot
        .documents
        .iter()
        .map(|document| {
            let body = match &document.body {
                OwnedDocumentBody::Yjs { rich_title, blocks } => OwnedDocumentBody::Yjs {
                    rich_title: if document.owner_type == "page"
                        && snapshot
                            .roots
                            .iter()
                            .any(|root| root.id == document.owner_block_id)
                    {
                        duplicate_rich_title(rich_title)
                    } else {
                        rich_title.clone()
                    },
                    blocks: remap_materialized_blocks(blocks, block_ids)?,
                },
                OwnedDocumentBody::Canvas { scene } => OwnedDocumentBody::Canvas {
                    scene: scene.clone(),
                },
            };
            Ok(OwnedDocumentSnapshot {
                owner_block_id: mapped(block_ids, &document.owner_block_id, "Document owner")?
                    .clone(),
                owner_type: document.owner_type.clone(),
                document_id: mapped(document_ids, &document.document_id, "Document")?.clone(),
                containing_document_id: if document.containing_document_id
                    == snapshot.source.document_id
                {
                    source.document_id.clone()
                } else {
                    mapped(
                        document_ids,
                        &document.containing_document_id,
                        "Containing Document",
                    )?
                    .clone()
                },
                schema_key: document.schema_key.clone(),
                schema_version: document.schema_version,
                generation: 1,
                head_seq: 0,
                body,
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    let pages = snapshot
        .pages
        .iter()
        .map(|page| {
            Ok(PageAuthoritySnapshot {
                block_id: mapped(block_ids, &page.block_id, "Page")?.clone(),
                document_id: mapped(document_ids, &page.document_id, "Page Document")?.clone(),
                parent_kind: page.parent_kind.clone(),
                parent_id: if page.parent_kind == "data_source" {
                    mapped(data_source_ids, &page.parent_id, "Data Source")?.clone()
                } else {
                    source.host_page_id.clone()
                },
                properties: page.properties.clone(),
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    let databases = snapshot
        .databases
        .iter()
        .map(|database| {
            Ok(DatabaseAuthoritySnapshot {
                block_id: mapped(block_ids, &database.block_id, "Database")?.clone(),
                name: if snapshot
                    .roots
                    .iter()
                    .any(|root| root.id == database.block_id)
                {
                    duplicate_plain_title(&database.name)
                } else {
                    database.name.clone()
                },
                lifecycle: "active".to_owned(),
                default_view_id: database
                    .default_view_id
                    .as_ref()
                    .map(|view_id| mapped(view_ids, view_id, "Default View").cloned())
                    .transpose()?,
                access_revision: 1,
                metadata_revision: 1,
                sources: database
                    .sources
                    .iter()
                    .map(|item| {
                        Ok(DatabaseSourceSnapshot {
                            source_id: mapped(data_source_ids, &item.source_id, "Data Source")?
                                .clone(),
                            name: item.name.clone(),
                            schema_key: item.schema_key.clone(),
                            schema_revision: 1,
                            rank_key: item.rank_key.clone(),
                        })
                    })
                    .collect::<Result<Vec<_>, StoreError>>()?,
                properties: database
                    .properties
                    .iter()
                    .map(|item| {
                        Ok(DatabasePropertySnapshot {
                            source_id: mapped(data_source_ids, &item.source_id, "Data Source")?
                                .clone(),
                            property_id: item.property_id.clone(),
                            name: item.name.clone(),
                            value_type: item.value_type.clone(),
                            config_json: item.config_json.clone(),
                            rank_key: item.rank_key.clone(),
                            lifecycle: item.lifecycle.clone(),
                            schema_revision: 1,
                        })
                    })
                    .collect::<Result<Vec<_>, StoreError>>()?,
                relation_properties: database
                    .relation_properties
                    .iter()
                    .map(|item| {
                        Ok(DatabaseRelationPropertySnapshot {
                            source_id: mapped(data_source_ids, &item.source_id, "Data Source")?
                                .clone(),
                            property_id: item.property_id.clone(),
                            target_source_id: data_source_ids
                                .get(&item.target_source_id)
                                .unwrap_or(&item.target_source_id)
                                .clone(),
                            cardinality: item.cardinality.clone(),
                        })
                    })
                    .collect::<Result<Vec<_>, StoreError>>()?,
                views: database
                    .views
                    .iter()
                    .map(|item| {
                        Ok(DatabaseViewSnapshot {
                            view_id: mapped(view_ids, &item.view_id, "View")?.clone(),
                            source_id: mapped(data_source_ids, &item.source_id, "Data Source")?
                                .clone(),
                            name: item.name.clone(),
                            default_layout: item.default_layout.clone(),
                            config_json: item.config_json.clone(),
                            revision: 1,
                            rank_key: item.rank_key.clone(),
                            lifecycle: item.lifecycle.clone(),
                        })
                    })
                    .collect::<Result<Vec<_>, StoreError>>()?,
                rows: database
                    .rows
                    .iter()
                    .map(|row| {
                        Ok(DatabaseRowSnapshot {
                            membership_id: mapped(
                                membership_ids,
                                &row.membership_id,
                                "Membership",
                            )?
                            .clone(),
                            source_id: mapped(data_source_ids, &row.source_id, "Data Source")?
                                .clone(),
                            page_id: mapped(block_ids, &row.page_id, "Database row Page")?.clone(),
                            revision: 1,
                            completed_at: row.completed_at.clone(),
                            projected_view_id: row
                                .projected_view_id
                                .as_ref()
                                .map(|view_id| mapped(view_ids, view_id, "View").cloned())
                                .transpose()?,
                            view_group_key: row.view_group_key.clone(),
                            view_rank_key: row.view_rank_key.clone(),
                            database_values_json: row.database_values_json.clone(),
                            property_values: row
                                .property_values
                                .iter()
                                .map(|value| DatabasePropertyValueSnapshot {
                                    property_id: value.property_id.clone(),
                                    value_type: value.value_type.clone(),
                                    value_json: value.value_json.clone(),
                                    revision: 1,
                                })
                                .collect(),
                            view_positions: row
                                .view_positions
                                .iter()
                                .map(|position| {
                                    Ok(DatabaseViewPositionSnapshot {
                                        view_id: mapped(view_ids, &position.view_id, "View")?
                                            .clone(),
                                        rank_key: position.rank_key.clone(),
                                        revision: 1,
                                    })
                                })
                                .collect::<Result<Vec<_>, StoreError>>()?,
                            relation_edges: row
                                .relation_edges
                                .iter()
                                .map(|edge| {
                                    Ok(DatabaseRelationEdgeSnapshot {
                                        edge_id: sha256(
                                            format!(
                                                "{}\0{}",
                                                mapped(
                                                    membership_ids,
                                                    &row.membership_id,
                                                    "Membership",
                                                )?,
                                                edge.edge_id
                                            )
                                            .as_bytes(),
                                        ),
                                        property_id: edge.property_id.clone(),
                                        target_page_id: block_ids
                                            .get(&edge.target_page_id)
                                            .unwrap_or(&edge.target_page_id)
                                            .clone(),
                                        sibling_rank: edge.sibling_rank.clone(),
                                    })
                                })
                                .collect::<Result<Vec<_>, StoreError>>()?,
                        })
                    })
                    .collect::<Result<Vec<_>, StoreError>>()?,
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;
    Ok(OwnershipClosureSnapshot {
        version: SNAPSHOT_VERSION,
        roots: remap_materialized_blocks(&snapshot.roots, block_ids)?,
        blocks,
        documents,
        pages,
        databases,
        host_page_file_ids: snapshot.host_page_file_ids.clone(),
        source,
    })
}

fn duplicate_rich_title(title: &[RichTextItem]) -> Vec<RichTextItem> {
    let mut duplicated = title.to_vec();
    let Some(text) = duplicated.iter_mut().rev().find_map(|item| match item {
        RichTextItem::Text { text, .. } => Some(text),
        _ => None,
    }) else {
        return duplicated;
    };
    if text.is_empty() {
        return duplicated;
    }
    *text = duplicate_plain_title(text);
    duplicated
}

fn duplicate_plain_title(title: &str) -> String {
    if title.is_empty() {
        return String::new();
    }
    let Some(open) = title.rfind(" (") else {
        return format!("{title} (1)");
    };
    let Some(number) = title.get(open + 2..title.len().saturating_sub(1)) else {
        return format!("{title} (1)");
    };
    if !title.ends_with(')')
        || number.is_empty()
        || number.starts_with('0')
        || !number.bytes().all(|byte| byte.is_ascii_digit())
    {
        return format!("{title} (1)");
    }
    let Ok(number) = number.parse::<u64>() else {
        return format!("{title} (1)");
    };
    let Some(next) = number.checked_add(1) else {
        return format!("{title} (1)");
    };
    format!("{} ({next})", &title[..open])
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use nodex_core_contracts::library::{
        LibraryCanvasDestination, LibraryIntent, LibraryPageInsertion, LibraryPageWriteDestination,
        LibraryWriteParent,
    };
    use nodex_core_contracts::{
        AdapterKind, CoreErrorCode, LIBRARY_CONTRACT_VERSION, LibraryId, ModuleApplyRequest,
        ProfileId, ProjectId, StoreEpoch,
    };
    use serde_json::Value;
    use tempfile::tempdir;

    use super::*;
    use crate::infrastructure::sqlite::with_immediate_transaction;
    use crate::infrastructure::store::SqliteStoreKernel;
    use crate::library::LibraryModule;

    fn paragraph(id: &str, children: Vec<MaterializedBlockNode>) -> MaterializedBlockNode {
        MaterializedBlockNode {
            id: id.to_owned(),
            block_type: "paragraph".to_owned(),
            props: BTreeMap::new(),
            content: Some(Value::Array(Vec::new())),
            children,
        }
    }

    #[test]
    fn authenticated_snapshot_normalization_expands_lifted_roots_and_their_coordinates() {
        let stored = OwnershipClosureSnapshot {
            version: SNAPSHOT_VERSION,
            roots: vec![MaterializedBlockNode {
                id: "code".to_owned(),
                block_type: "codeBlock".to_owned(),
                props: BTreeMap::new(),
                content: Some(Value::Array(Vec::new())),
                children: vec![paragraph("lifted", Vec::new())],
            }],
            blocks: Vec::new(),
            documents: vec![OwnedDocumentSnapshot {
                owner_block_id: "page:nested".to_owned(),
                owner_type: "page".to_owned(),
                document_id: "document:nested".to_owned(),
                containing_document_id: "document:source".to_owned(),
                schema_key: "nodex.page".to_owned(),
                schema_version: 2,
                generation: 1,
                head_seq: 1,
                body: OwnedDocumentBody::Yjs {
                    rich_title: Vec::new(),
                    blocks: vec![MaterializedBlockNode {
                        id: "nested-code".to_owned(),
                        block_type: "codeBlock".to_owned(),
                        props: BTreeMap::new(),
                        content: Some(Value::Array(Vec::new())),
                        children: vec![paragraph("nested-lifted", Vec::new())],
                    }],
                },
            }],
            pages: Vec::new(),
            databases: Vec::new(),
            host_page_file_ids: Vec::new(),
            source: StructuralLocation {
                document_id: "document:source".to_owned(),
                document_generation: 1,
                host_page_id: "page:source".to_owned(),
                placements: vec![RootPlacement {
                    block_id: "code".to_owned(),
                    parent_block_id: None,
                    before_block_id: Some("after".to_owned()),
                }],
                placeholder_block_id: None,
            },
        };
        let original = stored.clone();

        let (normalized, expansion, document_expansions) =
            normalize_stored_snapshot(stored).expect("normalize authenticated snapshot");

        assert_eq!(root_ids(&normalized.roots), ["code", "lifted"]);
        assert_eq!(expansion["code"], ["code", "lifted"]);
        assert_eq!(
            normalized
                .source
                .placements
                .iter()
                .map(|placement| placement.block_id.as_str())
                .collect::<Vec<_>>(),
            ["code", "lifted"]
        );
        assert!(
            normalized
                .source
                .placements
                .iter()
                .all(|placement| placement.before_block_id.as_deref() == Some("after"))
        );
        let document = &normalized.documents[0];
        assert_eq!(document.schema_version, 3);
        let OwnedDocumentBody::Yjs { blocks, .. } = &document.body else {
            panic!("Page Document must remain Yjs");
        };
        assert_eq!(root_ids(blocks), ["nested-code", "nested-lifted"]);
        assert_eq!(
            expand_stored_root_ids(
                &["nested-code".to_owned()],
                &document_expansions["document:nested"],
            )
            .expect("expand dormant Page roots"),
            ["nested-code", "nested-lifted"]
        );

        let recipe = normalize_stored_recipe(StructuralHistoryRecipe {
            version: RECIPE_VERSION,
            action: StructuralRecipeAction::RestoreTurnedSelection {
                state: TurnedSelectionState {
                    original: original.clone(),
                    active: original.clone(),
                    target: LibraryStructuralTurnIntoTarget::Paragraph,
                    dormant_pages: vec![DormantPageState {
                        page_id: "page:nested".to_owned(),
                        document_id: "document:nested".to_owned(),
                        generation: 1,
                        head_seq: 1,
                        placeholder_block_id: "placeholder".to_owned(),
                        moved_root_ids: vec!["nested-code".to_owned()],
                        moved_block_ids: vec!["nested-code".to_owned(), "nested-lifted".to_owned()],
                        revoked_grant_ids: Vec::new(),
                    }],
                },
            },
        })
        .expect("normalize Turn history coordinates");
        let StructuralRecipeAction::RestoreTurnedSelection { state } = recipe.action else {
            panic!("recipe kind must remain stable");
        };
        assert_eq!(
            state.dormant_pages[0].moved_root_ids,
            ["nested-code", "nested-lifted"]
        );
        assert_eq!(original.roots[0].children[0].id, "lifted");

        let expected_content = serde_json::json!([{
            "type": "text",
            "text": "Page mention",
            "styles": {},
        }]);
        let replacement_content = serde_json::json!([{
            "type": "link",
            "href": "nodex://page/page:created",
            "content": [{ "type": "text", "text": "Page mention", "styles": {} }],
        }]);
        let recipe = normalize_stored_recipe(StructuralHistoryRecipe {
            version: RECIPE_VERSION,
            action: StructuralRecipeAction::WithInlineContent {
                action: Box::new(StructuralRecipeAction::DeleteActive {
                    snapshot: original.clone(),
                    source: original.source.clone(),
                    direction: LibraryStructuralDeleteDirection::Backward,
                }),
                host_page_id: "page:host".to_owned(),
                host_document_id: "document:host".to_owned(),
                block_id: "block:host".to_owned(),
                expected_content: expected_content.clone(),
                replacement_content: replacement_content.clone(),
            },
        })
        .expect("normalize wrapped structural history coordinates");
        let StructuralRecipeAction::WithInlineContent {
            action,
            host_page_id,
            host_document_id,
            block_id,
            expected_content: normalized_expected_content,
            replacement_content: normalized_replacement_content,
        } = recipe.action
        else {
            panic!("recipe wrapper must remain stable");
        };
        assert_eq!(host_page_id, "page:host");
        assert_eq!(host_document_id, "document:host");
        assert_eq!(block_id, "block:host");
        assert_eq!(normalized_expected_content, expected_content);
        assert_eq!(normalized_replacement_content, replacement_content);
        let StructuralRecipeAction::DeleteActive {
            snapshot, source, ..
        } = *action
        else {
            panic!("wrapped action kind must remain stable");
        };
        assert_eq!(root_ids(&snapshot.roots), ["code", "lifted"]);
        assert_eq!(
            source
                .placements
                .iter()
                .map(|placement| placement.block_id.as_str())
                .collect::<Vec<_>>(),
            ["code", "lifted"]
        );
    }

    #[test]
    fn selection_normalization_keeps_an_ordered_minimal_root_forest() {
        let tree = vec![
            paragraph(
                "a",
                vec![paragraph("a-1", Vec::new()), paragraph("a-2", Vec::new())],
            ),
            paragraph("b", Vec::new()),
            paragraph("c", Vec::new()),
        ];
        let (roots, placements) =
            normalize_selection(&tree, &["a-1".to_owned(), "a".to_owned(), "b".to_owned()])
                .expect("normalize selection");
        assert_eq!(root_ids(&roots), vec!["a", "b"]);
        assert_eq!(placements[0].before_block_id.as_deref(), Some("c"));
        assert_eq!(placements[1].before_block_id.as_deref(), Some("c"));
    }

    #[test]
    fn backward_merge_plan_keeps_atomic_siblings_and_lifts_source_children_in_place() {
        let text = |id: &str, value: &str, children| MaterializedBlockNode {
            id: id.to_owned(),
            block_type: "paragraph".to_owned(),
            props: BTreeMap::new(),
            content: Some(serde_json::json!([{
                "type": "text",
                "text": value,
                "styles": {},
            }])),
            children,
        };
        let atomic = |id: &str, block_type: &str| MaterializedBlockNode {
            id: id.to_owned(),
            block_type: block_type.to_owned(),
            props: BTreeMap::new(),
            content: None,
            children: Vec::new(),
        };
        let tree = vec![
            text("target", "ABC", Vec::new()),
            atomic("page", "page"),
            atomic("divider", "divider"),
            text("source", "123", vec![text("child", "child", Vec::new())]),
            text("after", "after", Vec::new()),
        ];

        let plan = plan_backward_merge(&tree, "source", "target").expect("merge plan");
        assert_eq!(
            plan.merged_content,
            serde_json::json!([
                { "type": "text", "text": "ABC", "styles": {} },
                { "type": "text", "text": "123", "styles": {} }
            ])
        );
        assert_eq!(plan.promoted_child_ids, vec!["child"]);
        assert_eq!(plan.source_before_block_id.as_deref(), Some("after"));
        assert_eq!(plan.target.id, "target");
    }

    #[test]
    fn backward_merge_plan_rejects_an_editable_gap_or_non_paragraph_source() {
        let mut target = paragraph("target", Vec::new());
        target.content = Some(serde_json::json!([]));
        let editable_gap = vec![
            target.clone(),
            paragraph("closer", Vec::new()),
            paragraph("source", Vec::new()),
        ];
        assert!(plan_backward_merge(&editable_gap, "source", "target").is_err());

        let mut heading = paragraph("source", Vec::new());
        heading.block_type = "heading".to_owned();
        let non_paragraph = vec![
            target,
            MaterializedBlockNode {
                id: "image".to_owned(),
                block_type: "image".to_owned(),
                props: BTreeMap::new(),
                content: None,
                children: Vec::new(),
            },
            heading,
        ];
        assert!(plan_backward_merge(&non_paragraph, "source", "target").is_err());
    }

    #[test]
    fn backward_merge_and_history_preserve_typed_child_identity() {
        const NOW: &str = "2026-08-25T12:00:00.000Z";
        const HOST_PAGE: &str = "018f0000-0000-7000-8000-000000000851";
        const HOST_DOCUMENT: &str = "document:backward-merge-host";
        const SUBPAGE: &str = "018f0000-0000-7000-8000-000000000852";
        const SUBPAGE_DOCUMENT: &str = "document:backward-merge-subpage";
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh Store");
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES ('library-1', 'profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO projects(id, library_id, name, created, updated) \
                         VALUES ('project-1', 'library-1', 'Backward merge', ?1, ?1)",
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
            .expect("seed Library");
        let context = BoundModuleContext {
            profile_id: ProfileId("profile-1".to_owned()),
            library_id: LibraryId("library-1".to_owned()),
            project_id: Some(ProjectId("project-1".to_owned())),
            connection_id: "connection:backward-merge".to_owned(),
            adapter: AdapterKind::Test,
        };
        let module = LibraryModule::new("profile-1", "library-1", &kernel);
        let created = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "backward-merge:create-host".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: HOST_PAGE.to_owned(),
                        document_id: HOST_DOCUMENT.to_owned(),
                        title: "Host".to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .expect("create host Page");
        let placeholder_id = created
            .committed
            .value
            .page_create
            .expect("Page creation")
            .block_ids[0]
            .clone();
        let head = |document_id: &str| {
            kernel
                .readers()
                .read_default(|connection| {
                    connection
                        .query_row(
                            "SELECT generation, head_seq FROM documents WHERE id = ?1",
                            [document_id],
                            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                        )
                        .map_err(Into::into)
                })
                .expect("Document head")
        };
        let initial_head = head(HOST_DOCUMENT);
        let replaced = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "backward-merge:seed-blocks".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::ReplaceSelection {
                            selection: LibraryStructuralSelection {
                                source_document_id: HOST_DOCUMENT.to_owned(),
                                root_block_ids: vec![placeholder_id],
                                source_head: nodex_core_contracts::library::LibraryDocumentHead {
                                    document_id: HOST_DOCUMENT.to_owned(),
                                    generation: initial_head.0,
                                    head_seq: initial_head.1,
                                },
                            },
                            replacement: LibraryStructuralReplacement::Blocks {
                                blocks: vec![
                                    LibraryStructuralReplacementBlock {
                                        block_type: "paragraph".to_owned(),
                                        props: BTreeMap::new(),
                                        content: Some(serde_json::json!([{
                                            "type": "text", "text": "ABC", "styles": {}
                                        }])),
                                        children: Vec::new(),
                                    },
                                    LibraryStructuralReplacementBlock {
                                        block_type: "image".to_owned(),
                                        props: BTreeMap::from([
                                            ("url".to_owned(), serde_json::json!("https://example.test/image.png")),
                                            ("name".to_owned(), serde_json::json!("")),
                                            ("caption".to_owned(), serde_json::json!("")),
                                        ]),
                                        content: None,
                                        children: Vec::new(),
                                    },
                                    LibraryStructuralReplacementBlock {
                                        block_type: "paragraph".to_owned(),
                                        props: BTreeMap::new(),
                                        content: Some(serde_json::json!([{
                                            "type": "text", "text": "123", "styles": {}
                                        }])),
                                        children: vec![LibraryStructuralReplacementBlock {
                                            block_type: "paragraph".to_owned(),
                                            props: BTreeMap::new(),
                                            content: Some(serde_json::json!([{
                                                "type": "text", "text": "ordinary child", "styles": {}
                                            }])),
                                            children: Vec::new(),
                                        }],
                                    },
                                ],
                            },
                        }),
                    },
                },
            )
            .expect("seed merge Blocks");
        let seeded = replaced
            .committed
            .value
            .structural_edit
            .expect("replacement result")
            .result_root_block_ids;
        let target_id = seeded[0].clone();
        let image_id = seeded[1].clone();
        let source_id = seeded[2].clone();
        let seeded_head = head(HOST_DOCUMENT);
        module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "backward-merge:create-subpage".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: SUBPAGE.to_owned(),
                        document_id: SUBPAGE_DOCUMENT.to_owned(),
                        title: "Nested".to_owned(),
                        parent: LibraryWriteParent::Page {
                            page_id: HOST_PAGE.to_owned(),
                            expected_document_generation: seeded_head.0,
                            expected_document_head_seq: seeded_head.1,
                            before: None,
                            insertion: Some(LibraryPageInsertion::Append {
                                parent_block_id: Some(source_id.clone()),
                            }),
                        },
                    },
                },
            )
            .expect("create typed child");
        let merge_head = head(HOST_DOCUMENT);
        let merged = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "backward-merge:apply".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::MergeBlockBackward {
                            selection: LibraryStructuralSelection {
                                source_document_id: HOST_DOCUMENT.to_owned(),
                                root_block_ids: vec![source_id.clone()],
                                source_head: nodex_core_contracts::library::LibraryDocumentHead {
                                    document_id: HOST_DOCUMENT.to_owned(),
                                    generation: merge_head.0,
                                    head_seq: merge_head.1,
                                },
                            },
                            target_block_id: target_id.clone(),
                        }),
                    },
                },
            )
            .expect("merge backward");
        let history = merged
            .committed
            .value
            .structural_edit
            .expect("merge result")
            .history
            .expect("merge history");

        let assert_tree = |merged: bool| {
            kernel
                .readers()
                .read_default(|connection| {
                    let parent = load_parent_document(connection, HOST_DOCUMENT)?;
                    let roots = &parent.base_materialization.block_tree;
                    let target = find_block(roots, &target_id).expect("target");
                    let text = target
                        .content
                        .as_ref()
                        .and_then(Value::as_array)
                        .expect("target inline")
                        .iter()
                        .filter_map(|item| item.get("text").and_then(Value::as_str))
                        .collect::<String>();
                    assert_eq!(text, if merged { "ABC123" } else { "ABC" });
                    let source = find_block(roots, &source_id);
                    if merged {
                        assert!(source.is_none());
                        let root_ids = roots
                            .iter()
                            .map(|block| block.id.as_str())
                            .collect::<Vec<_>>();
                        let image_index = root_ids.iter().position(|id| *id == image_id).unwrap();
                        assert_eq!(root_ids[image_index + 2], SUBPAGE);
                    } else {
                        let source = source.expect("restored source");
                        assert_eq!(
                            source.children.last().map(|child| child.id.as_str()),
                            Some(SUBPAGE)
                        );
                    }
                    let authority = connection.query_row(
                        "SELECT block.lifecycle, page.document_id, page.parent_id \
                         FROM blocks block, pages page WHERE block.id = ?1 AND page.block_id = ?1",
                        [SUBPAGE],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                            ))
                        },
                    )?;
                    assert_eq!(
                        authority,
                        (
                            "active".to_owned(),
                            SUBPAGE_DOCUMENT.to_owned(),
                            HOST_PAGE.to_owned()
                        )
                    );
                    Ok(())
                })
                .expect("inspect backward merge");
        };
        assert_tree(true);
        let undone = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "backward-merge:undo".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ReverseStructuralEdit { token: history },
                },
            )
            .expect("undo backward merge");
        assert_tree(false);
        let redo = undone
            .committed
            .value
            .structural_edit
            .expect("undo result")
            .history
            .expect("redo history");
        module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "backward-merge:redo".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ReverseStructuralEdit { token: redo },
                },
            )
            .expect("redo backward merge");
        assert_tree(true);
    }

    #[test]
    fn duplicate_title_increments_only_a_canonical_trailing_suffix() {
        assert_eq!(duplicate_plain_title("abc"), "abc (1)");
        assert_eq!(duplicate_plain_title("abc (1)"), "abc (2)");
        assert_eq!(duplicate_plain_title("abc (99)"), "abc (100)");
        assert_eq!(duplicate_plain_title("abc (01)"), "abc (01) (1)");
        assert_eq!(duplicate_plain_title("abc (x)"), "abc (x) (1)");
        assert_eq!(duplicate_plain_title(""), "");
    }

    #[test]
    fn duplicate_title_preserves_trailing_rich_atoms() {
        let title = vec![
            RichTextItem::Text {
                text: "abc".to_owned(),
                styles: Default::default(),
            },
            RichTextItem::PageMention {
                target_page_id: "page:mentioned".to_owned(),
            },
        ];

        assert_eq!(
            duplicate_rich_title(&title),
            vec![
                RichTextItem::Text {
                    text: "abc (1)".to_owned(),
                    styles: Default::default(),
                },
                RichTextItem::PageMention {
                    target_page_id: "page:mentioned".to_owned(),
                },
            ]
        );
    }

    #[test]
    fn ordinary_replacement_rejects_an_excessively_deep_tree() {
        let mut block = LibraryStructuralReplacementBlock {
            block_type: "paragraph".to_owned(),
            props: BTreeMap::new(),
            content: Some(Value::Array(Vec::new())),
            children: Vec::new(),
        };
        for _ in 0..=MAX_STRUCTURAL_DEPTH {
            block = LibraryStructuralReplacementBlock {
                block_type: "paragraph".to_owned(),
                props: BTreeMap::new(),
                content: Some(Value::Array(Vec::new())),
                children: vec![block],
            };
        }

        let error = materialize_replacement_blocks("replacement:deep", &[block])
            .expect_err("deep replacement must fail closed");
        assert_eq!(error.code, StoreErrorCode::ResourceExhausted);
    }

    #[test]
    fn deletion_resume_respects_keyboard_direction() {
        let tree = vec![
            paragraph("before", Vec::new()),
            paragraph("selected", Vec::new()),
            paragraph("after", Vec::new()),
        ];
        let snapshot = OwnershipClosureSnapshot {
            version: SNAPSHOT_VERSION,
            roots: vec![tree[1].clone()],
            blocks: vec![BlockAuthoritySnapshot {
                block_id: "selected".to_owned(),
                block_type: "paragraph".to_owned(),
                lifecycle: "active".to_owned(),
                metadata_revision: 1,
                placement_revision: 1,
                containing_document_id: "document".to_owned(),
                in_host_document: true,
            }],
            documents: Vec::new(),
            pages: Vec::new(),
            databases: Vec::new(),
            host_page_file_ids: Vec::new(),
            source: StructuralLocation {
                document_id: "document".to_owned(),
                document_generation: 1,
                host_page_id: "page".to_owned(),
                placements: vec![RootPlacement {
                    block_id: "selected".to_owned(),
                    parent_block_id: None,
                    before_block_id: Some("after".to_owned()),
                }],
                placeholder_block_id: None,
            },
        };
        let backward = deletion_resume_target(
            &tree,
            &snapshot,
            None,
            LibraryStructuralDeleteDirection::Backward,
        )
        .expect("backward resume");
        assert_eq!(backward.block_id, "before");
        assert_eq!(backward.edge, LibraryEditorResumeEdge::End);

        let forward = deletion_resume_target(
            &tree,
            &snapshot,
            None,
            LibraryStructuralDeleteDirection::Forward,
        )
        .expect("forward resume");
        assert_eq!(forward.block_id, "after");
        assert_eq!(forward.edge, LibraryEditorResumeEdge::Start);
    }

    #[test]
    fn ordinary_subtree_move_across_owners_and_mixed_delete_history_preserve_identity() {
        const NOW: &str = "2026-08-21T16:00:00.000Z";
        const SOURCE_PAGE: &str = "018f0000-0000-7000-8000-000000000701";
        const SOURCE_DOCUMENT: &str = "document:structural-source";
        const SUBPAGE: &str = "018f0000-0000-7000-8000-000000000702";
        const SUBPAGE_DOCUMENT: &str = "document:structural-subpage";
        const CANVAS: &str = "018f0000-0000-7000-8000-000000000703";
        const CANVAS_DOCUMENT: &str = "018f0000-0000-7000-8000-000000000704";
        const DATABASE: &str = "018f0000-0000-7000-8000-000000000705";
        const DATA_SOURCE: &str = "018f0000-0000-7000-8000-000000000706";
        const VIEW: &str = "018f0000-0000-7000-8000-000000000707";
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh Store");
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES ('library-1', 'profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO projects(id, library_id, name, created, updated) \
                         VALUES ('project-1', 'library-1', 'Structural', ?1, ?1)",
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
            .expect("seed Library");
        let context = BoundModuleContext {
            profile_id: ProfileId("profile-1".to_owned()),
            library_id: LibraryId("library-1".to_owned()),
            project_id: Some(ProjectId("project-1".to_owned())),
            connection_id: "connection:structural-edit".to_owned(),
            adapter: AdapterKind::Test,
        };
        let module = LibraryModule::new("profile-1", "library-1", &kernel);
        module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "structural:create-source".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: SOURCE_PAGE.to_owned(),
                        document_id: SOURCE_DOCUMENT.to_owned(),
                        title: "Source".to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .expect("create source Page");
        module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "structural:create-subpage".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: SUBPAGE.to_owned(),
                        document_id: SUBPAGE_DOCUMENT.to_owned(),
                        title: "abc".to_owned(),
                        parent: LibraryWriteParent::Page {
                            page_id: SOURCE_PAGE.to_owned(),
                            expected_document_generation: 1,
                            expected_document_head_seq: 1,
                            before: None,
                            insertion: None,
                        },
                    },
                },
            )
            .expect("create subpage");
        let source_head_after_subpage = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT generation, head_seq FROM documents WHERE id = ?1",
                        [SOURCE_DOCUMENT],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                    )
                    .map_err(Into::into)
            })
            .expect("source head after subpage");
        module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "structural:create-canvas".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreateCanvas {
                        canvas_id: CANVAS.to_owned(),
                        document_id: CANVAS_DOCUMENT.to_owned(),
                        display_name: "Sketch".to_owned(),
                        destination: LibraryCanvasDestination::Page {
                            page_id: SOURCE_PAGE.to_owned(),
                            expected_document_generation: source_head_after_subpage.0,
                            expected_document_head_seq: source_head_after_subpage.1,
                            insertion: LibraryPageInsertion::Append {
                                parent_block_id: None,
                            },
                        },
                    },
                },
            )
            .expect("create nested Canvas");
        let source_head_after_canvas = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT generation, head_seq FROM documents WHERE id = ?1",
                        [SOURCE_DOCUMENT],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                    )
                    .map_err(Into::into)
            })
            .expect("source head after Canvas");
        module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "structural:create-database".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreateDatabase {
                        database_id: DATABASE.to_owned(),
                        data_source_id: DATA_SOURCE.to_owned(),
                        view_id: VIEW.to_owned(),
                        name: "Tasks".to_owned(),
                        parent: LibraryWriteParent::Page {
                            page_id: SOURCE_PAGE.to_owned(),
                            expected_document_generation: source_head_after_canvas.0,
                            expected_document_head_seq: source_head_after_canvas.1,
                            before: None,
                            insertion: None,
                        },
                    },
                },
            )
            .expect("create nested Database");
        let (initial_root_ids, source_head) = kernel
            .readers()
            .read_default(|connection| {
                let roots = connection
                    .prepare(
                        "SELECT block_id FROM document_block_index \
                         WHERE document_id = ?1 AND parent_block_id IS NULL ORDER BY ordinal",
                    )?
                    .query_map([SOURCE_DOCUMENT], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let head = connection.query_row(
                    "SELECT generation, head_seq FROM documents WHERE id = ?1",
                    [SOURCE_DOCUMENT],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )?;
                Ok((roots, head))
            })
            .expect("source authority");
        assert!(
            initial_root_ids.len() >= 2,
            "fixture has ordinary content and a subpage"
        );
        assert!(initial_root_ids.iter().any(|block_id| block_id == SUBPAGE));
        assert!(initial_root_ids.iter().any(|block_id| block_id == CANVAS));
        assert!(initial_root_ids.iter().any(|block_id| block_id == DATABASE));

        let ordinary_root_id = initial_root_ids
            .iter()
            .find(|block_id| ![SUBPAGE, CANVAS, DATABASE].contains(&block_id.as_str()))
            .expect("ordinary root")
            .clone();
        let nested_replacement = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "structural:create-ordinary-subtree".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::ReplaceSelection {
                            selection: LibraryStructuralSelection {
                                source_document_id: SOURCE_DOCUMENT.to_owned(),
                                root_block_ids: vec![ordinary_root_id],
                                source_head: nodex_core_contracts::library::LibraryDocumentHead {
                                    document_id: SOURCE_DOCUMENT.to_owned(),
                                    generation: source_head.0,
                                    head_seq: source_head.1,
                                },
                            },
                            replacement: LibraryStructuralReplacement::Blocks {
                                blocks: vec![LibraryStructuralReplacementBlock {
                                    block_type: "paragraph".to_owned(),
                                    props: BTreeMap::new(),
                                    content: Some(serde_json::json!([{
                                        "type": "text",
                                        "text": "1111",
                                        "styles": {},
                                    }])),
                                    children: vec![LibraryStructuralReplacementBlock {
                                        block_type: "paragraph".to_owned(),
                                        props: BTreeMap::new(),
                                        content: Some(serde_json::json!([{
                                            "type": "text",
                                            "text": "222",
                                            "styles": {},
                                        }])),
                                        children: Vec::new(),
                                    }],
                                }],
                            },
                        }),
                    },
                },
            )
            .expect("create ordinary subtree before typed owners");
        let nested_root_id = nested_replacement
            .committed
            .value
            .structural_edit
            .expect("ordinary subtree result")
            .result_root_block_ids
            .into_iter()
            .next()
            .expect("ordinary subtree root");
        let source_head = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT generation, head_seq FROM documents WHERE id = ?1",
                        [SOURCE_DOCUMENT],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                    )
                    .map_err(Into::into)
            })
            .expect("source head before ordinary subtree move");
        module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "structural:move-ordinary-subtree-across-owners".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::MoveSelection {
                            selection: LibraryStructuralSelection {
                                source_document_id: SOURCE_DOCUMENT.to_owned(),
                                root_block_ids: vec![nested_root_id.clone()],
                                source_head: nodex_core_contracts::library::LibraryDocumentHead {
                                    document_id: SOURCE_DOCUMENT.to_owned(),
                                    generation: source_head.0,
                                    head_seq: source_head.1,
                                },
                            },
                            target: LibraryStructuralTarget {
                                target_document_id: SOURCE_DOCUMENT.to_owned(),
                                parent_block_id: None,
                                before_block_id: None,
                                target_head: nodex_core_contracts::library::LibraryDocumentHead {
                                    document_id: SOURCE_DOCUMENT.to_owned(),
                                    generation: source_head.0,
                                    head_seq: source_head.1,
                                },
                            },
                        }),
                    },
                },
            )
            .expect("move ordinary subtree across typed owners");
        let (root_ids, source_head, nested_child_count) = kernel
            .readers()
            .read_default(|connection| {
                let roots = connection
                    .prepare(
                        "SELECT block_id FROM document_block_index \
                         WHERE document_id = ?1 AND parent_block_id IS NULL ORDER BY ordinal",
                    )?
                    .query_map([SOURCE_DOCUMENT], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let head = connection.query_row(
                    "SELECT generation, head_seq FROM documents WHERE id = ?1",
                    [SOURCE_DOCUMENT],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )?;
                let child_count = connection.query_row(
                    "SELECT count(*) FROM document_block_index \
                     WHERE document_id = ?1 AND parent_block_id = ?2",
                    params![SOURCE_DOCUMENT, nested_root_id],
                    |row| row.get::<_, i64>(0),
                )?;
                Ok((roots, head, child_count))
            })
            .expect("source authority after ordinary subtree move");
        assert_eq!(root_ids.last(), Some(&nested_root_id));
        assert_eq!(nested_child_count, 1);
        let nested_position = root_ids
            .iter()
            .position(|id| id == &nested_root_id)
            .expect("moved ordinary subtree position");
        for typed_owner_id in [SUBPAGE, CANVAS, DATABASE] {
            assert!(
                root_ids.iter().position(|id| id == typed_owner_id) < Some(nested_position),
                "ordinary subtree moved after {typed_owner_id}",
            );
        }

        let rejected_turn = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "structural:reject-turn-with-owners".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::TurnSelectionInto {
                            selection: LibraryStructuralSelection {
                                source_document_id: SOURCE_DOCUMENT.to_owned(),
                                root_block_ids: root_ids.clone(),
                                source_head: nodex_core_contracts::library::LibraryDocumentHead {
                                    document_id: SOURCE_DOCUMENT.to_owned(),
                                    generation: source_head.0,
                                    head_seq: source_head.1,
                                },
                            },
                            target: LibraryStructuralTurnIntoTarget::Paragraph,
                        }),
                    },
                },
            )
            .expect_err("Canvas and Database make the whole turn unsupported");
        assert_eq!(rejected_turn.code, CoreErrorCode::SchemaUnsupported);
        kernel
            .readers()
            .read_default(|connection| {
                let unchanged_head = connection.query_row(
                    "SELECT generation, head_seq FROM documents WHERE id = ?1",
                    [SOURCE_DOCUMENT],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )?;
                assert_eq!(unchanged_head, source_head);
                let owner_types = connection
                    .prepare("SELECT type FROM blocks WHERE id IN (?1, ?2, ?3) ORDER BY type")?
                    .query_map(params![SUBPAGE, CANVAS, DATABASE], |row| {
                        row.get::<_, String>(0)
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                assert_eq!(owner_types, vec!["canvas", "database", "page"]);
                Ok(())
            })
            .expect("rejected turn is atomic");

        let deleted = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "structural:delete-mixed".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::DeleteSelection {
                            selection: LibraryStructuralSelection {
                                source_document_id: SOURCE_DOCUMENT.to_owned(),
                                root_block_ids: root_ids.clone(),
                                source_head: nodex_core_contracts::library::LibraryDocumentHead {
                                    document_id: SOURCE_DOCUMENT.to_owned(),
                                    generation: source_head.0,
                                    head_seq: source_head.1,
                                },
                            },
                            reason: LibraryStructuralDeleteReason::Delete,
                            direction: LibraryStructuralDeleteDirection::Backward,
                        }),
                    },
                },
            )
            .expect("delete mixed selection");
        let deleted_result = deleted
            .committed
            .value
            .structural_edit
            .expect("structural result");
        let delete_token = deleted_result.history.expect("delete history");
        assert!(deleted_result.result_root_block_ids.is_empty());
        assert!(deleted_result.resume.is_some());
        kernel
            .readers()
            .read_default(|connection| {
                let lifecycle = connection.query_row(
                    "SELECT lifecycle FROM page_read_model WHERE page_block_id = ?1",
                    [SUBPAGE],
                    |row| row.get::<_, String>(0),
                )?;
                assert_eq!(lifecycle, "deleted");
                let canvas_lifecycle = connection.query_row(
                    "SELECT lifecycle FROM blocks WHERE id = ?1",
                    [CANVAS],
                    |row| row.get::<_, String>(0),
                )?;
                assert_eq!(canvas_lifecycle, "deleted");
                let database_lifecycle = connection.query_row(
                    "SELECT lifecycle FROM database_containers WHERE block_id = ?1",
                    [DATABASE],
                    |row| row.get::<_, String>(0),
                )?;
                assert_eq!(database_lifecycle, "deleted");
                Ok(())
            })
            .expect("deleted authority");

        let restored = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "structural:undo-delete".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ReverseStructuralEdit {
                        token: delete_token,
                    },
                },
            )
            .expect("reverse deletion");
        let restored_result = restored
            .committed
            .value
            .structural_edit
            .expect("restore result");
        assert_eq!(restored_result.result_root_block_ids, root_ids);
        let redo_token = restored_result.history.expect("redo history");
        kernel
            .readers()
            .read_default(|connection| {
                let identity = connection.query_row(
                    "SELECT model.lifecycle, model.document_id, block.lifecycle \
                     FROM page_read_model model JOIN blocks block ON block.id = model.page_block_id \
                     WHERE model.page_block_id = ?1",
                    [SUBPAGE],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )?;
                assert_eq!(identity, ("active".to_owned(), SUBPAGE_DOCUMENT.to_owned(), "active".to_owned()));
                Ok(())
            })
            .expect("restored same identity");

        let redone = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "structural:redo-delete".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ReverseStructuralEdit { token: redo_token },
                },
            )
            .expect("redo deletion");
        assert!(
            redone
                .committed
                .value
                .structural_edit
                .expect("redo result")
                .result_root_block_ids
                .is_empty()
        );
    }

    #[test]
    fn clipboard_copy_and_mixed_cut_move_preserve_complete_subpage_authority() {
        const NOW: &str = "2026-08-21T17:00:00.000Z";
        const SOURCE_PAGE: &str = "018f0000-0000-7000-8000-000000000711";
        const SOURCE_DOCUMENT: &str = "document:clipboard-source";
        const TARGET_PAGE: &str = "018f0000-0000-7000-8000-000000000712";
        const TARGET_DOCUMENT: &str = "document:clipboard-target";
        const SUBPAGE: &str = "018f0000-0000-7000-8000-000000000713";
        const SUBPAGE_DOCUMENT: &str = "document:clipboard-subpage";
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh Store");
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES ('library-1', 'profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO projects(id, library_id, name, created, updated) \
                         VALUES ('project-1', 'library-1', 'Clipboard', ?1, ?1)",
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
            .expect("seed Library");
        let context = BoundModuleContext {
            profile_id: ProfileId("profile-1".to_owned()),
            library_id: LibraryId("library-1".to_owned()),
            project_id: Some(ProjectId("project-1".to_owned())),
            connection_id: "connection:structural-clipboard".to_owned(),
            adapter: AdapterKind::Test,
        };
        let module = LibraryModule::new("profile-1", "library-1", &kernel);
        for (operation_id, page_id, document_id, title) in [
            (
                "clipboard:create-source",
                SOURCE_PAGE,
                SOURCE_DOCUMENT,
                "Source",
            ),
            (
                "clipboard:create-target",
                TARGET_PAGE,
                TARGET_DOCUMENT,
                "Target",
            ),
        ] {
            module
                .apply(
                    &context,
                    ModuleApplyRequest {
                        contract_version: LIBRARY_CONTRACT_VERSION,
                        operation_id: operation_id.to_owned(),
                        store_epoch: StoreEpoch("epoch-1".to_owned()),
                        intent: LibraryIntent::CreatePage {
                            page_id: page_id.to_owned(),
                            document_id: document_id.to_owned(),
                            title: title.to_owned(),
                            parent: LibraryWriteParent::Library { before: None },
                        },
                    },
                )
                .expect("create host Page");
        }
        module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "clipboard:create-subpage".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: SUBPAGE.to_owned(),
                        document_id: SUBPAGE_DOCUMENT.to_owned(),
                        title: "abc".to_owned(),
                        parent: LibraryWriteParent::Page {
                            page_id: SOURCE_PAGE.to_owned(),
                            expected_document_generation: 1,
                            expected_document_head_seq: 1,
                            before: None,
                            insertion: None,
                        },
                    },
                },
            )
            .expect("create subpage");
        let heads = |document_id: &str| {
            kernel
                .readers()
                .read_default(|connection| {
                    connection
                        .query_row(
                            "SELECT generation, head_seq FROM documents WHERE id = ?1",
                            [document_id],
                            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                        )
                        .map_err(Into::into)
                })
                .expect("Document head")
        };
        let mixed_root_ids = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .prepare(
                        "SELECT block_id FROM document_block_index \
                         WHERE document_id = ?1 AND parent_block_id IS NULL ORDER BY ordinal",
                    )?
                    .query_map([SOURCE_DOCUMENT], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(Into::into)
            })
            .expect("mixed source roots");
        assert!(mixed_root_ids.len() >= 2);
        assert!(mixed_root_ids.iter().any(|block_id| block_id == SUBPAGE));
        let source_head = heads(SOURCE_DOCUMENT);
        let captured = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "clipboard:capture".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::CaptureClipboard {
                            selection: LibraryStructuralSelection {
                                source_document_id: SOURCE_DOCUMENT.to_owned(),
                                root_block_ids: mixed_root_ids.clone(),
                                source_head: nodex_core_contracts::library::LibraryDocumentHead {
                                    document_id: SOURCE_DOCUMENT.to_owned(),
                                    generation: source_head.0,
                                    head_seq: source_head.1,
                                },
                            },
                        }),
                    },
                },
            )
            .expect("capture clipboard");
        let clipboard = captured
            .committed
            .value
            .structural_edit
            .expect("capture result")
            .clipboard
            .expect("clipboard token");
        let target_head = heads(TARGET_DOCUMENT);
        let invalid_clipboard = LibraryStructuralClipboardToken {
            capability: "0".repeat(64),
            ..clipboard.clone()
        };
        let invalid_paste = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "clipboard:paste-invalid-capability".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::PasteClipboard {
                            bundle: invalid_clipboard,
                            target: LibraryStructuralTarget {
                                target_document_id: TARGET_DOCUMENT.to_owned(),
                                parent_block_id: None,
                                before_block_id: None,
                                target_head: nodex_core_contracts::library::LibraryDocumentHead {
                                    document_id: TARGET_DOCUMENT.to_owned(),
                                    generation: target_head.0,
                                    head_seq: target_head.1,
                                },
                            },
                        }),
                    },
                },
            )
            .expect_err("invalid clipboard capability");
        assert_eq!(invalid_paste.code, CoreErrorCode::Unauthorized);
        assert_eq!(heads(TARGET_DOCUMENT), target_head);
        let pasted = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "clipboard:paste".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::PasteClipboard {
                            bundle: clipboard.clone(),
                            target: LibraryStructuralTarget {
                                target_document_id: TARGET_DOCUMENT.to_owned(),
                                parent_block_id: None,
                                before_block_id: None,
                                target_head: nodex_core_contracts::library::LibraryDocumentHead {
                                    document_id: TARGET_DOCUMENT.to_owned(),
                                    generation: target_head.0,
                                    head_seq: target_head.1,
                                },
                            },
                        }),
                    },
                },
            )
            .expect("paste clipboard");
        let result = pasted
            .committed
            .value
            .structural_edit
            .expect("paste result");
        let cloned_page = result
            .copied_block_ids
            .get(SUBPAGE)
            .expect("cloned Page identity");
        let cloned_document = result
            .copied_document_ids
            .get(SUBPAGE_DOCUMENT)
            .expect("cloned Document identity");
        assert_ne!(cloned_page, SUBPAGE);
        assert_ne!(cloned_document, SUBPAGE_DOCUMENT);
        kernel
            .readers()
            .read_default(|connection| {
                let cloned = connection.query_row(
                    "SELECT model.title, model.parent_id, model.document_id, block.lifecycle \
                     FROM page_read_model model JOIN blocks block ON block.id = model.page_block_id \
                     WHERE model.page_block_id = ?1",
                    [cloned_page],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    },
                )?;
                assert_eq!(
                    cloned,
                    (
                        "abc (1)".to_owned(),
                        TARGET_PAGE.to_owned(),
                        cloned_document.clone(),
                        "active".to_owned(),
                    )
                );
                Ok(())
            })
            .expect("cloned Page authority");

        let cut = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "clipboard:cut".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::DeleteSelection {
                            selection: LibraryStructuralSelection {
                                source_document_id: SOURCE_DOCUMENT.to_owned(),
                                root_block_ids: mixed_root_ids.clone(),
                                source_head: nodex_core_contracts::library::LibraryDocumentHead {
                                    document_id: SOURCE_DOCUMENT.to_owned(),
                                    generation: source_head.0,
                                    head_seq: source_head.1,
                                },
                            },
                            reason: LibraryStructuralDeleteReason::Cut {
                                bundle: clipboard.clone(),
                            },
                            direction: LibraryStructuralDeleteDirection::Backward,
                        }),
                    },
                },
            )
            .expect("cut source subpage");
        let cut_history = cut
            .committed
            .value
            .structural_edit
            .expect("cut result")
            .history
            .expect("cut history");
        let moved_target_head = heads(TARGET_DOCUMENT);
        let moved = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "clipboard:paste-cut".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::PasteClipboard {
                            bundle: clipboard.clone(),
                            target: LibraryStructuralTarget {
                                target_document_id: TARGET_DOCUMENT.to_owned(),
                                parent_block_id: None,
                                before_block_id: None,
                                target_head: nodex_core_contracts::library::LibraryDocumentHead {
                                    document_id: TARGET_DOCUMENT.to_owned(),
                                    generation: moved_target_head.0,
                                    head_seq: moved_target_head.1,
                                },
                            },
                        }),
                    },
                },
            )
            .expect("paste cut subpage");
        let moved_result = moved.committed.value.structural_edit.expect("move result");
        assert_eq!(moved_result.result_root_block_ids, mixed_root_ids);
        assert!(moved_result.copied_block_ids.is_empty());
        assert_eq!(
            moved_result.superseded_history_recipe_operation_ids,
            vec![cut_history.recipe_operation_id]
        );
        let move_history = moved_result.history.expect("move history");
        kernel
            .readers()
            .read_default(|connection| {
                let parent = connection.query_row(
                    "SELECT parent_id FROM page_read_model WHERE page_block_id = ?1",
                    [SUBPAGE],
                    |row| row.get::<_, String>(0),
                )?;
                assert_eq!(parent, TARGET_PAGE);
                Ok(())
            })
            .expect("moved Page parent");

        module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "clipboard:undo-move".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ReverseStructuralEdit {
                        token: move_history,
                    },
                },
            )
            .expect("undo cut paste");
        kernel
            .readers()
            .read_default(|connection| {
                let parent = connection.query_row(
                    "SELECT parent_id FROM page_read_model WHERE page_block_id = ?1",
                    [SUBPAGE],
                    |row| row.get::<_, String>(0),
                )?;
                assert_eq!(parent, SOURCE_PAGE);
                Ok(())
            })
            .expect("restored source parent");

        let source_head = heads(SOURCE_DOCUMENT);
        let undo_cut_capture = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "clipboard:capture-before-undo-cut".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::CaptureClipboard {
                            selection: LibraryStructuralSelection {
                                source_document_id: SOURCE_DOCUMENT.to_owned(),
                                root_block_ids: mixed_root_ids.clone(),
                                source_head: nodex_core_contracts::library::LibraryDocumentHead {
                                    document_id: SOURCE_DOCUMENT.to_owned(),
                                    generation: source_head.0,
                                    head_seq: source_head.1,
                                },
                            },
                        }),
                    },
                },
            )
            .expect("capture before undoing cut");
        let undo_cut_clipboard = undo_cut_capture
            .committed
            .value
            .structural_edit
            .expect("capture result")
            .clipboard
            .expect("clipboard token");
        let cut_head = heads(SOURCE_DOCUMENT);
        let undoable_cut = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "clipboard:cut-before-undo".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::DeleteSelection {
                            selection: LibraryStructuralSelection {
                                source_document_id: SOURCE_DOCUMENT.to_owned(),
                                root_block_ids: mixed_root_ids.clone(),
                                source_head: nodex_core_contracts::library::LibraryDocumentHead {
                                    document_id: SOURCE_DOCUMENT.to_owned(),
                                    generation: cut_head.0,
                                    head_seq: cut_head.1,
                                },
                            },
                            reason: LibraryStructuralDeleteReason::Cut {
                                bundle: undo_cut_clipboard.clone(),
                            },
                            direction: LibraryStructuralDeleteDirection::Backward,
                        }),
                    },
                },
            )
            .expect("cut before undo");
        let undoable_cut_history = undoable_cut
            .committed
            .value
            .structural_edit
            .expect("cut result")
            .history
            .expect("cut history");
        module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "clipboard:undo-cut-before-paste".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ReverseStructuralEdit {
                        token: undoable_cut_history,
                    },
                },
            )
            .expect("undo cut before paste");
        let target_head = heads(TARGET_DOCUMENT);
        let pasted_after_undo = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "clipboard:paste-after-undo-cut".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::PasteClipboard {
                            bundle: undo_cut_clipboard.clone(),
                            target: LibraryStructuralTarget {
                                target_document_id: TARGET_DOCUMENT.to_owned(),
                                parent_block_id: None,
                                before_block_id: None,
                                target_head: nodex_core_contracts::library::LibraryDocumentHead {
                                    document_id: TARGET_DOCUMENT.to_owned(),
                                    generation: target_head.0,
                                    head_seq: target_head.1,
                                },
                            },
                        }),
                    },
                },
            )
            .expect("paste copy after undoing cut");
        let pasted_after_undo = pasted_after_undo
            .committed
            .value
            .structural_edit
            .expect("paste result");
        assert_ne!(
            pasted_after_undo
                .copied_block_ids
                .get(SUBPAGE)
                .expect("undo cut pastes a clone"),
            SUBPAGE,
        );
        assert!(
            pasted_after_undo
                .superseded_history_recipe_operation_ids
                .is_empty()
        );

        let source_head = heads(SOURCE_DOCUMENT);
        let target_head = heads(TARGET_DOCUMENT);
        let duplicated = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "clipboard:duplicate-direct".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::DuplicateSelection {
                            selection: LibraryStructuralSelection {
                                source_document_id: SOURCE_DOCUMENT.to_owned(),
                                root_block_ids: vec![SUBPAGE.to_owned()],
                                source_head: nodex_core_contracts::library::LibraryDocumentHead {
                                    document_id: SOURCE_DOCUMENT.to_owned(),
                                    generation: source_head.0,
                                    head_seq: source_head.1,
                                },
                            },
                            target: LibraryStructuralTarget {
                                target_document_id: TARGET_DOCUMENT.to_owned(),
                                parent_block_id: None,
                                before_block_id: None,
                                target_head: nodex_core_contracts::library::LibraryDocumentHead {
                                    document_id: TARGET_DOCUMENT.to_owned(),
                                    generation: target_head.0,
                                    head_seq: target_head.1,
                                },
                            },
                        }),
                    },
                },
            )
            .expect("duplicate source selection directly");
        let duplicate_history = duplicated
            .committed
            .value
            .structural_edit
            .expect("duplicate result")
            .history
            .expect("duplicate history");

        module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "clipboard:release-history".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::ReleaseHistory {
                            tokens: vec![duplicate_history.clone()],
                        }),
                    },
                },
            )
            .expect("release unreachable history");
        kernel
            .readers()
            .read_default(|connection| {
                let state = connection.query_row(
                    "SELECT state FROM structural_history_recipes \
                     WHERE recipe_operation_id = ?1",
                    [&duplicate_history.recipe_operation_id],
                    |row| row.get::<_, String>(0),
                )?;
                assert_eq!(state, "consumed");
                let retention_count = connection.query_row(
                    "SELECT count(*) FROM structural_retention_members \
                     WHERE authority_kind = 'history_recipe' AND authority_id = ?1",
                    [&duplicate_history.recipe_operation_id],
                    |row| row.get::<_, i64>(0),
                )?;
                assert_eq!(retention_count, 0);
                Ok(())
            })
            .expect("released history retention");

        let source_head = heads(SOURCE_DOCUMENT);
        let target_head = heads(TARGET_DOCUMENT);
        let moved = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "clipboard:move-direct".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::MoveSelection {
                            selection: LibraryStructuralSelection {
                                source_document_id: SOURCE_DOCUMENT.to_owned(),
                                root_block_ids: vec![SUBPAGE.to_owned()],
                                source_head: nodex_core_contracts::library::LibraryDocumentHead {
                                    document_id: SOURCE_DOCUMENT.to_owned(),
                                    generation: source_head.0,
                                    head_seq: source_head.1,
                                },
                            },
                            target: LibraryStructuralTarget {
                                target_document_id: TARGET_DOCUMENT.to_owned(),
                                parent_block_id: None,
                                before_block_id: None,
                                target_head: nodex_core_contracts::library::LibraryDocumentHead {
                                    document_id: TARGET_DOCUMENT.to_owned(),
                                    generation: target_head.0,
                                    head_seq: target_head.1,
                                },
                            },
                        }),
                    },
                },
            )
            .expect("move source selection directly");
        let move_history = moved
            .committed
            .value
            .structural_edit
            .expect("move result")
            .history
            .expect("move history");
        kernel
            .readers()
            .read_default(|connection| {
                let parent = connection.query_row(
                    "SELECT parent_id FROM page_read_model WHERE page_block_id = ?1",
                    [SUBPAGE],
                    |row| row.get::<_, String>(0),
                )?;
                assert_eq!(parent, TARGET_PAGE);
                Ok(())
            })
            .expect("directly moved Page parent");
        module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "clipboard:undo-move-direct".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ReverseStructuralEdit {
                        token: move_history,
                    },
                },
            )
            .expect("undo direct move");

        let source_head = heads(SOURCE_DOCUMENT);
        let replaced_with_text = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "clipboard:replace-with-text".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::ReplaceSelection {
                            selection: LibraryStructuralSelection {
                                source_document_id: SOURCE_DOCUMENT.to_owned(),
                                root_block_ids: vec![SUBPAGE.to_owned()],
                                source_head: nodex_core_contracts::library::LibraryDocumentHead {
                                    document_id: SOURCE_DOCUMENT.to_owned(),
                                    generation: source_head.0,
                                    head_seq: source_head.1,
                                },
                            },
                            replacement: LibraryStructuralReplacement::Blocks {
                                blocks: vec![LibraryStructuralReplacementBlock {
                                    block_type: "paragraph".to_owned(),
                                    props: BTreeMap::new(),
                                    content: Some(serde_json::json!([{
                                        "type": "text",
                                        "text": "typed",
                                        "styles": {},
                                    }])),
                                    children: Vec::new(),
                                }],
                            },
                        }),
                    },
                },
            )
            .expect("replace typed owner with text");
        let text_result = replaced_with_text
            .committed
            .value
            .structural_edit
            .expect("text replacement result");
        assert_eq!(text_result.result_root_block_ids.len(), 1);
        let text_block_id = text_result.result_root_block_ids[0].clone();
        let text_history = text_result.history.expect("text replacement history");
        kernel
            .readers()
            .read_default(|connection| {
                let lifecycles = connection.query_row(
                    "SELECT original.lifecycle, replacement.lifecycle FROM blocks original, blocks replacement \
                     WHERE original.id = ?1 AND replacement.id = ?2",
                    params![SUBPAGE, text_block_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )?;
                assert_eq!(lifecycles, ("deleted".to_owned(), "active".to_owned()));
                Ok(())
            })
            .expect("replacement authority");
        module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "clipboard:undo-replace-with-text".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ReverseStructuralEdit {
                        token: text_history,
                    },
                },
            )
            .expect("undo text replacement");

        let source_head = heads(SOURCE_DOCUMENT);
        let replaced_with_clipboard = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "clipboard:replace-with-clipboard".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::ReplaceSelection {
                            selection: LibraryStructuralSelection {
                                source_document_id: SOURCE_DOCUMENT.to_owned(),
                                root_block_ids: vec![SUBPAGE.to_owned()],
                                source_head: nodex_core_contracts::library::LibraryDocumentHead {
                                    document_id: SOURCE_DOCUMENT.to_owned(),
                                    generation: source_head.0,
                                    head_seq: source_head.1,
                                },
                            },
                            replacement: LibraryStructuralReplacement::Clipboard {
                                bundle: undo_cut_clipboard,
                            },
                        }),
                    },
                },
            )
            .expect("replace typed owner from clipboard");
        let clipboard_result = replaced_with_clipboard
            .committed
            .value
            .structural_edit
            .expect("clipboard replacement result");
        let replacement_page_id = clipboard_result.result_root_block_ids[0].clone();
        assert_ne!(replacement_page_id, SUBPAGE);
        let clipboard_history = clipboard_result
            .history
            .expect("clipboard replacement history");
        module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "clipboard:undo-replace-with-clipboard".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ReverseStructuralEdit {
                        token: clipboard_history,
                    },
                },
            )
            .expect("undo clipboard replacement");
        kernel
            .readers()
            .read_default(|connection| {
                let lifecycles = connection.query_row(
                    "SELECT original.lifecycle, replacement.lifecycle FROM blocks original, blocks replacement \
                     WHERE original.id = ?1 AND replacement.id = ?2",
                    params![SUBPAGE, replacement_page_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )?;
                assert_eq!(lifecycles, ("active".to_owned(), "deleted".to_owned()));
                Ok(())
            })
            .expect("clipboard replacement undo authority");
    }

    #[test]
    fn turn_subpage_into_toggle_and_history_preserve_page_and_document_identity() {
        const NOW: &str = "2026-08-23T18:00:00.000Z";
        const HOST_PAGE: &str = "018f0000-0000-7000-8000-000000000751";
        const HOST_DOCUMENT: &str = "document:turn-host";
        const SUBPAGE: &str = "018f0000-0000-7000-8000-000000000752";
        const SUBPAGE_DOCUMENT: &str = "document:turn-subpage";
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh Store");
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES ('library-1', 'profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO projects(id, library_id, name, created, updated) \
                         VALUES ('project-1', 'library-1', 'Turn into', ?1, ?1)",
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
            .expect("seed Library");
        let context = BoundModuleContext {
            profile_id: ProfileId("profile-1".to_owned()),
            library_id: LibraryId("library-1".to_owned()),
            project_id: Some(ProjectId("project-1".to_owned())),
            connection_id: "connection:turn-into".to_owned(),
            adapter: AdapterKind::Test,
        };
        let module = LibraryModule::new("profile-1", "library-1", &kernel);
        module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "turn:create-host".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: HOST_PAGE.to_owned(),
                        document_id: HOST_DOCUMENT.to_owned(),
                        title: "Host".to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .expect("create host");
        module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "turn:create-subpage".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: SUBPAGE.to_owned(),
                        document_id: SUBPAGE_DOCUMENT.to_owned(),
                        title: "Rich subpage".to_owned(),
                        parent: LibraryWriteParent::Page {
                            page_id: HOST_PAGE.to_owned(),
                            expected_document_generation: 1,
                            expected_document_head_seq: 1,
                            before: None,
                            insertion: None,
                        },
                    },
                },
            )
            .expect("create subpage");
        let head = kernel
            .readers()
            .read_default(|connection| {
                connection
                    .query_row(
                        "SELECT generation, head_seq FROM documents WHERE id = ?1",
                        [HOST_DOCUMENT],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                    )
                    .map_err(Into::into)
            })
            .expect("host head");
        let turned = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "turn:apply".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::TurnSelectionInto {
                            selection: LibraryStructuralSelection {
                                source_document_id: HOST_DOCUMENT.to_owned(),
                                root_block_ids: vec![SUBPAGE.to_owned()],
                                source_head: nodex_core_contracts::library::LibraryDocumentHead {
                                    document_id: HOST_DOCUMENT.to_owned(),
                                    generation: head.0,
                                    head_seq: head.1,
                                },
                            },
                            target: LibraryStructuralTurnIntoTarget::ToggleList,
                        }),
                    },
                },
            )
            .expect("turn subpage");
        let turned_result = turned.committed.value.structural_edit.expect("turn result");
        assert_eq!(turned_result.result_root_block_ids, vec![SUBPAGE]);
        let undo = turned_result.history.expect("turn history");
        kernel
            .readers()
            .read_default(|connection| {
                let block_type = connection.query_row(
                    "SELECT type FROM blocks WHERE id = ?1",
                    [SUBPAGE],
                    |row| row.get::<_, String>(0),
                )?;
                assert_eq!(block_type, "toggleListItem");
                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM pages WHERE block_id = ?1",
                        [SUBPAGE],
                        |row| row.get::<_, i64>(0),
                    )?,
                    0
                );
                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM documents WHERE id = ?1",
                        [SUBPAGE_DOCUMENT],
                        |row| row.get::<_, i64>(0),
                    )?,
                    1
                );
                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM structural_retention_members \
                         WHERE authority_kind = 'history_recipe' \
                           AND authority_id = 'turn:apply' \
                           AND member_kind = 'document' AND member_id = ?1",
                        [SUBPAGE_DOCUMENT],
                        |row| row.get::<_, i64>(0),
                    )?,
                    1
                );
                crate::infrastructure::store_validation::validate_store_semantics(connection)?;
                Ok(())
            })
            .expect("turned authority");

        let restored = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "turn:undo".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ReverseStructuralEdit { token: undo },
                },
            )
            .expect("undo turn");
        let redo = restored
            .committed
            .value
            .structural_edit
            .expect("undo result")
            .history
            .expect("redo history");
        kernel
            .readers()
            .read_default(|connection| {
                let restored = connection.query_row(
                    "SELECT block.type, page.document_id, model.title \
                     FROM blocks block JOIN pages page ON page.block_id = block.id \
                     JOIN page_read_model model ON model.page_block_id = block.id \
                     WHERE block.id = ?1",
                    [SUBPAGE],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )?;
                assert_eq!(
                    restored,
                    (
                        "page".to_owned(),
                        SUBPAGE_DOCUMENT.to_owned(),
                        "Rich subpage".to_owned(),
                    )
                );
                crate::infrastructure::store_validation::validate_store_semantics(connection)?;
                Ok(())
            })
            .expect("restored authority");

        let redone = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "turn:redo".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ReverseStructuralEdit { token: redo },
                },
            )
            .expect("redo turn");
        let released_history = redone
            .committed
            .value
            .structural_edit
            .expect("redo result")
            .history
            .expect("second undo history");
        kernel
            .readers()
            .read_default(|connection| {
                let current = connection.query_row(
                    "SELECT type FROM blocks WHERE id = ?1",
                    [SUBPAGE],
                    |row| row.get::<_, String>(0),
                )?;
                assert_eq!(current, "toggleListItem");
                crate::infrastructure::store_validation::validate_store_semantics(connection)?;
                Ok(())
            })
            .expect("redone authority");

        module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "turn:release-history".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::ReleaseHistory {
                            tokens: vec![released_history],
                        }),
                    },
                },
            )
            .expect("release turned Page history");
        kernel
            .writer()
            .call(|connection| {
                let summary = crate::document::run_block_retention_pass(connection, 0)?;
                assert_eq!(summary.collected_candidates, 1);
                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM documents WHERE id = ?1",
                        [SUBPAGE_DOCUMENT],
                        |row| row.get::<_, i64>(0),
                    )?,
                    0
                );
                assert_eq!(
                    connection.query_row(
                        "SELECT type FROM blocks WHERE id = ?1",
                        [SUBPAGE],
                        |row| row.get::<_, String>(0),
                    )?,
                    "toggleListItem"
                );
                crate::infrastructure::store_validation::validate_store_semantics(connection)?;
                Ok(())
            })
            .expect("collect released dormant Page Document");
    }

    #[test]
    fn turn_nonempty_subpage_reparents_body_owners_and_restores_them_across_history() {
        const NOW: &str = "2026-08-23T19:00:00.000Z";
        const HOST_PAGE: &str = "018f0000-0000-7000-8000-000000000761";
        const HOST_DOCUMENT: &str = "document:turn-nonempty-host";
        const NESTED_PAGE: &str = "018f0000-0000-7000-8000-000000000762";
        const NESTED_DOCUMENT: &str = "document:turn-nested-page";
        let directory = tempdir().expect("Profile");
        let home = directory.path().canonicalize().expect("absolute Profile");
        let kernel = SqliteStoreKernel::open_test(&home).expect("fresh Store");
        kernel
            .writer()
            .call(|connection| {
                with_immediate_transaction(connection, |transaction| {
                    transaction.execute(
                        "INSERT INTO profiles(id, created_at, updated_at) VALUES ('profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO libraries(id, profile_id, created_at, updated_at) \
                         VALUES ('library-1', 'profile-1', ?1, ?1)",
                        [NOW],
                    )?;
                    transaction.execute(
                        "INSERT INTO projects(id, library_id, name, created, updated) \
                         VALUES ('project-1', 'library-1', 'Turn nonempty', ?1, ?1)",
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
            .expect("seed Library");
        let context = BoundModuleContext {
            profile_id: ProfileId("profile-1".to_owned()),
            library_id: LibraryId("library-1".to_owned()),
            project_id: Some(ProjectId("project-1".to_owned())),
            connection_id: "connection:turn-nonempty".to_owned(),
            adapter: AdapterKind::Test,
        };
        let module = LibraryModule::new("profile-1", "library-1", &kernel);
        module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "turn-nonempty:create-host".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: HOST_PAGE.to_owned(),
                        document_id: HOST_DOCUMENT.to_owned(),
                        title: "Host".to_owned(),
                        parent: LibraryWriteParent::Library { before: None },
                    },
                },
            )
            .expect("create host");
        let created = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "turn-nonempty:create-subpage".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePageFromNfm {
                        title_markdown: "Rich **subpage** [link](https://nodex.local)".to_owned(),
                        nfm: "Body paragraph\n\n- first\n  - nested".to_owned(),
                        destination: LibraryPageWriteDestination::Page {
                            page_id: HOST_PAGE.to_owned(),
                            at: None,
                        },
                    },
                },
            )
            .expect("create nonempty subpage")
            .committed
            .value
            .page_create
            .expect("page create result");
        let subpage_id = created.page_id;
        let subpage_document_id = created.document_id;
        module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "turn-nonempty:create-nested-page".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::CreatePage {
                        page_id: NESTED_PAGE.to_owned(),
                        document_id: NESTED_DOCUMENT.to_owned(),
                        title: "Nested".to_owned(),
                        parent: LibraryWriteParent::Page {
                            page_id: subpage_id.clone(),
                            expected_document_generation: created.document_generation,
                            expected_document_head_seq: created.document_head_seq,
                            before: None,
                            insertion: None,
                        },
                    },
                },
            )
            .expect("create nested Page");

        let (host_head, host_root_ids, original_title, original_root_ids, original_properties) =
            kernel
                .readers()
                .read_default(|connection| {
                    let host = load_parent_document(connection, HOST_DOCUMENT)?;
                    let subpage = load_parent_document(connection, &subpage_document_id)?;
                    let properties = connection
                        .prepare(
                            "SELECT property_key, value_type, value_json FROM block_properties \
                         WHERE block_id = ?1 ORDER BY property_key",
                        )?
                        .query_map([&subpage_id], |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                            ))
                        })?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    Ok((
                        (host.authority.head.generation, host.authority.head.head_seq),
                        root_ids(&host.base_materialization.block_tree),
                        subpage.base_materialization.rich_title,
                        root_ids(&subpage.base_materialization.block_tree),
                        properties,
                    ))
                })
                .expect("original Page materialization");
        assert!(original_root_ids.len() >= 3);
        assert!(
            original_root_ids
                .iter()
                .any(|block_id| block_id == NESTED_PAGE)
        );
        assert!(host_root_ids.iter().any(|block_id| block_id == &subpage_id));
        assert!(host_root_ids.iter().any(|block_id| block_id != &subpage_id));

        let turned = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "turn-nonempty:apply".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ApplyStructuralEdit {
                        command: Box::new(LibraryStructuralEditCommand::TurnSelectionInto {
                            selection: LibraryStructuralSelection {
                                source_document_id: HOST_DOCUMENT.to_owned(),
                                root_block_ids: host_root_ids.clone(),
                                source_head: nodex_core_contracts::library::LibraryDocumentHead {
                                    document_id: HOST_DOCUMENT.to_owned(),
                                    generation: host_head.0,
                                    head_seq: host_head.1,
                                },
                            },
                            target: LibraryStructuralTurnIntoTarget::ToggleList,
                        }),
                    },
                },
            )
            .expect("turn nonempty Page");
        let undo = turned
            .committed
            .value
            .structural_edit
            .expect("turn result")
            .history
            .expect("undo history");
        kernel
            .readers()
            .read_default(|connection| {
                let host = load_parent_document(connection, HOST_DOCUMENT)?;
                assert!(
                    host.base_materialization
                        .block_tree
                        .iter()
                        .all(|block| block.block_type == "toggleListItem")
                );
                let turned_block = flatten_blocks(&host.base_materialization.block_tree)
                    .into_iter()
                    .find(|block| block.id == subpage_id)
                    .expect("turned Block");
                assert_eq!(turned_block.block_type, "toggleListItem");
                assert_eq!(root_ids(&turned_block.children), original_root_ids);
                let turned_title =
                    crate::domain::materialized_inline::rich_text_from_materialized_inline(
                        turned_block.content.as_ref().expect("turned title"),
                    )
                    .expect("portable title")
                    .rich_text;
                assert_eq!(turned_title, original_title);
                let nested_parent = connection.query_row(
                    "SELECT parent_kind, parent_id FROM pages WHERE block_id = ?1",
                    [NESTED_PAGE],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )?;
                assert_eq!(nested_parent, ("page".to_owned(), HOST_PAGE.to_owned()));
                assert_eq!(
                    connection.query_row(
                        "SELECT count(*) FROM structural_retention_members \
                         WHERE authority_kind = 'history_recipe' \
                           AND authority_id = 'turn-nonempty:apply' \
                           AND member_kind = 'document' AND member_id = ?1",
                        [&subpage_document_id],
                        |row| row.get::<_, i64>(0),
                    )?,
                    1
                );
                crate::infrastructure::store_validation::validate_store_semantics(connection)?;
                Ok(())
            })
            .expect("turned hierarchy");

        let restored = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "turn-nonempty:undo".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ReverseStructuralEdit { token: undo },
                },
            )
            .expect("undo nonempty turn");
        let redo = restored
            .committed
            .value
            .structural_edit
            .expect("undo result")
            .history
            .expect("redo history");
        kernel
            .readers()
            .read_default(|connection| {
                let restored_page = load_parent_document(connection, &subpage_document_id)?;
                assert_eq!(
                    restored_page.base_materialization.rich_title,
                    original_title
                );
                assert_eq!(
                    root_ids(&restored_page.base_materialization.block_tree),
                    original_root_ids
                );
                let restored_properties = connection
                    .prepare(
                        "SELECT property_key, value_type, value_json FROM block_properties \
                         WHERE block_id = ?1 ORDER BY property_key",
                    )?
                    .query_map([&subpage_id], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                assert_eq!(restored_properties, original_properties);
                let host = load_parent_document(connection, HOST_DOCUMENT)?;
                let page_shell = flatten_blocks(&host.base_materialization.block_tree)
                    .into_iter()
                    .find(|block| block.id == subpage_id)
                    .expect("restored Page shell");
                assert_eq!(page_shell.block_type, "page");
                assert!(page_shell.children.is_empty());
                let nested_parent = connection.query_row(
                    "SELECT parent_kind, parent_id FROM pages WHERE block_id = ?1",
                    [NESTED_PAGE],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )?;
                assert_eq!(nested_parent, ("page".to_owned(), subpage_id.clone()));
                crate::infrastructure::store_validation::validate_store_semantics(connection)?;
                Ok(())
            })
            .expect("restored hierarchy");

        let redone = module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "turn-nonempty:redo".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ReverseStructuralEdit { token: redo },
                },
            )
            .expect("redo nonempty turn");
        let undo_again = redone
            .committed
            .value
            .structural_edit
            .expect("redo result")
            .history
            .expect("second undo history");
        module
            .apply(
                &context,
                ModuleApplyRequest {
                    contract_version: LIBRARY_CONTRACT_VERSION,
                    operation_id: "turn-nonempty:undo-again".to_owned(),
                    store_epoch: StoreEpoch("epoch-1".to_owned()),
                    intent: LibraryIntent::ReverseStructuralEdit { token: undo_again },
                },
            )
            .expect("second undo nonempty turn");
        kernel
            .readers()
            .read_default(|connection| {
                let restored = connection.query_row(
                    "SELECT page.document_id, block.type FROM pages page \
                     JOIN blocks block ON block.id = page.block_id WHERE page.block_id = ?1",
                    [&subpage_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )?;
                assert_eq!(restored, (subpage_document_id, "page".to_owned()));
                crate::infrastructure::store_validation::validate_store_semantics(connection)?;
                Ok(())
            })
            .expect("second restore keeps identity");
    }
}
