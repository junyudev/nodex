import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
} from "../../shared/database-identities";
import type { DatabaseViewLayout } from "../../shared/database-kernel";
import type {
  LibraryApplyOperation,
  LibraryCanvasDestination,
  LibraryModuleApplyRequest,
  LibraryModuleApplyResult,
  LibraryModuleError,
  LibraryModuleReadRequest,
  LibraryModuleReadResult,
  LibraryNavigationNode,
  LibraryNavigationParent,
  LibraryMoveDestinationScope,
  LibraryPageInsertion,
  LibraryReadValue,
  LibraryResourceTarget,
  LibraryRouteTarget,
  LibraryStructuralReplacementBlock,
  LibraryWriteParent,
} from "../../shared/library-module";
import {
  parseLibraryPageDetailResult,
  parsePageDetailResult,
  type LibraryPageDetailResult,
  type PageDetailError,
  type PageDetailResult,
} from "../../shared/page-detail";
import type { ListPageHistoryRequest } from "../../shared/page-history";
import {
  pageHistoryFailure,
  parsePageHistoryCommandResult,
  type PageHistoryCommandError,
  type PageHistoryCommandResult,
} from "../../shared/page-history-transport";
import type {
  PageSearchFacets,
  PageSearchInput,
  PageSearchMatch,
  PageSearchOption,
  PageSearchMetadataSnapshot,
  PageSearchResult,
  PageSearchSnapshot,
  PageSearchTextPart,
} from "../../shared/types";
import {
  parseBlockPropertyMutationCommandResultV2,
  parseLibraryBlockPropertyMutationCommandResultV2,
  type BlockPropertyMutationCommandResultV2,
  type BlockPropertyMutationFieldResultV2,
  type BlockPropertyMutationRequestV2,
  type BlockPropertyMutationResultV2,
  type LibraryBlockPropertyMutationCommandResultV2,
  type LibraryBlockPropertyMutationRequestV2,
} from "../../shared/block-property-mutations-v2";
import type { LocalCommitApply } from "../../shared/local-commit-delivery";
import { parsePage } from "../../shared/page";
import { type PageLifecyclePreflightResultV2 } from "../../shared/page-lifecycle-v2-runtime";
import { parsePageLifecyclePreflightResultV2 } from "../../shared/page-lifecycle-v2-transport";
import {
  parsePageLifecycleMutationCommandResultV2,
  type PageLifecycleMutationCommandResultV2,
  type PageLifecycleMutationErrorCodeV2,
  type PageLifecycleMutationRequestV2,
  type PageLifecycleOperationV2,
} from "../../shared/page-lifecycle-v2";
import type { PageTargetReadModel, ResolvePageTargetInput } from "../../shared/page-targets";
import type {
  PageOwnershipPathReadModel,
  ResolvePageOwnershipPathInput,
} from "../../shared/page-ownership-paths";
import type { AuthorizedReadStamp } from "../../shared/authorized-read-stamp";
import { isWorkflowStatus } from "../../shared/workflow-status";
import { isPriority } from "../../shared/priority";
import { CoreModuleResponseError } from "./core-client";
import { applyResultCursor, applyResultStoreEpoch, rendererLocalCommitApply } from "./types";
import { mapCorePropertyDescriptor, toCoreDatabaseIntent } from "./database-module-adapter";
import type {
  CoreClientPort,
  CoreModuleError,
  LibraryIntent,
  LibraryRead,
  LibraryReadSnapshot,
} from "./types";

export interface CoreLibraryModuleAdapterInput {
  readonly client: CoreClientPort;
  readonly libraryId: string;
  readonly profileId: string;
  readonly storeEpoch: string;
}

export interface CoreLibraryModuleAdapter {
  read(request: LibraryModuleReadRequest): Promise<LibraryModuleReadResult>;
  apply(request: LibraryModuleApplyRequest): Promise<LibraryModuleApplyResult>;
  readProjectPageDetail(projectId: string, pageId: string): Promise<PageDetailResult>;
  readLibraryPageDetail(pageId: string): Promise<LibraryPageDetailResult>;
  listPageHistory(request: ListPageHistoryRequest): Promise<PageHistoryCommandResult>;
  searchPages(input: PageSearchInput, signal?: AbortSignal): Promise<PageSearchSnapshot>;
  pageSearchMetadata(projectIds: string[], pageIds?: string[]): Promise<PageSearchMetadataSnapshot>;
  pageSearchFacets(projectIds: string[]): Promise<PageSearchFacets>;
  resolvePageTarget(input: ResolvePageTargetInput): Promise<PageTargetReadModel | null>;
  resolvePageOwnershipPath(
    input: ResolvePageOwnershipPathInput,
  ): Promise<PageOwnershipPathReadModel | null>;
  findPageLocation(
    pageId: string,
  ): Promise<{ readonly pageId: string; readonly projectId: string } | null>;
  findViewLocation(viewId: string): Promise<{
    readonly viewId: string;
    readonly dataSourceId: string;
    readonly databaseId: string;
    readonly projectId: string;
  } | null>;
  readPageLifecyclePreflight(
    projectId: string,
    pageId: string,
  ): Promise<PageLifecyclePreflightResultV2>;
  applyPageLifecycleMutation(
    request: PageLifecycleMutationRequestV2,
  ): Promise<PageLifecycleMutationCommandResultV2>;
  applyBlockPropertyMutation(
    request: BlockPropertyMutationRequestV2,
  ): Promise<BlockPropertyMutationCommandResultV2>;
  applyLibraryBlockPropertyMutation(input: {
    readonly request: LibraryBlockPropertyMutationRequestV2;
    readonly actor: BlockPropertyMutationRequestV2["actor"];
  }): Promise<LibraryBlockPropertyMutationCommandResultV2>;
}

const toCoreRouteTarget = (target: LibraryRouteTarget) => {
  if (target.kind === "page") return { kind: target.kind, page_id: target.pageId } as const;
  if (target.kind === "database") {
    return { kind: target.kind, database_id: target.databaseId } as const;
  }
  if (target.kind === "canvas") {
    return { kind: target.kind, canvas_id: target.canvasId } as const;
  }
  return { kind: target.kind, view_id: target.viewId } as const;
};

const toCoreResourceTarget = (target: LibraryResourceTarget) => {
  if (target.kind === "page") return { kind: target.kind, page_id: target.pageId } as const;
  if (target.kind === "database") {
    return { kind: target.kind, database_id: target.databaseId } as const;
  }
  return { kind: target.kind, canvas_id: target.canvasId } as const;
};

const toCoreParent = (parent: LibraryNavigationParent) => {
  if (parent.kind === "library") return parent;
  if (parent.kind === "page") return { kind: parent.kind, page_id: parent.pageId } as const;
  return { kind: parent.kind, database_id: parent.databaseId } as const;
};

const toCoreMoveDestinationScope = (scope: LibraryMoveDestinationScope) => {
  if (scope.kind === "suggested") return scope;
  if (scope.kind === "search") return scope;
  return { kind: scope.kind, parent: toCoreParent(scope.parent) } as const;
};

const toCorePageInsertion = (insertion: LibraryPageInsertion) => {
  if (insertion.kind === "append") {
    return {
      kind: insertion.kind,
      parent_block_id: insertion.parentBlockId ?? null,
    } as const;
  }
  if (insertion.kind === "before") {
    return {
      kind: insertion.kind,
      parent_block_id: insertion.parentBlockId ?? null,
      anchor_block_id: insertion.anchorBlockId,
    } as const;
  }
  return {
    kind: insertion.kind,
    block_id: insertion.blockId,
  } as const;
};

const toCoreWriteParent = (parent: LibraryWriteParent) => {
  const before = parent.before
    ? {
        block_id: parent.before.blockId,
        expected_location_revision: parent.before.expectedLocationRevision,
      }
    : null;
  if (parent.kind === "library") return { kind: parent.kind, before } as const;
  return {
    kind: parent.kind,
    page_id: parent.pageId,
    expected_document_generation: parent.expectedDocumentGeneration,
    expected_document_head_seq: parent.expectedDocumentHeadSeq,
    before,
    insertion: parent.insertion ? toCorePageInsertion(parent.insertion) : null,
  } as const;
};

const toCoreCanvasDestination = (destination: LibraryCanvasDestination) => {
  if (destination.kind === "library") {
    return {
      kind: destination.kind,
      before: destination.before
        ? {
            block_id: destination.before.blockId,
            expected_location_revision: destination.before.expectedLocationRevision,
          }
        : null,
    } as const;
  }
  return {
    kind: destination.kind,
    page_id: destination.pageId,
    expected_document_generation: destination.expectedDocumentGeneration,
    expected_document_head_seq: destination.expectedDocumentHeadSeq,
    insertion: toCorePageInsertion(destination.insertion),
  } as const;
};

const toCoreRead = (request: LibraryModuleReadRequest): LibraryRead => {
  const read = request.read;
  switch (read.mode) {
    case "metadata":
      return { kind: "metadata" };
    case "resource_project_access":
      return {
        kind: "resource_project_access",
        target: toCoreResourceTarget(read.target),
      };
    case "canvas_target":
      return { kind: "canvas_target", canvas_id: read.canvasId };
    case "children":
      return {
        kind: "children",
        parent: toCoreParent(read.parent),
        cursor: read.cursor ?? null,
        limit: read.limit,
        force_include_target: read.forceIncludeTarget
          ? toCoreRouteTarget(read.forceIncludeTarget)
          : null,
      };
    case "standalone_roots":
      return {
        kind: "standalone_roots",
        cursor: read.cursor ?? null,
        limit: read.limit,
        force_include_target: read.forceIncludeTarget
          ? toCoreResourceTarget(read.forceIncludeTarget)
          : null,
      };
    case "path":
      return { kind: "path", target: toCoreRouteTarget(read.target) };
    case "catalog":
      return {
        kind: "catalog",
        query: read.query ?? null,
        kinds: read.kinds ?? null,
        lifecycle: read.lifecycle ?? null,
        cursor: read.cursor ?? null,
        limit: read.limit,
      };
    case "move_destinations":
      return {
        kind: "move_destinations",
        target: toCoreResourceTarget(read.target),
        scope: toCoreMoveDestinationScope(read.scope),
        cursor: read.cursor ?? null,
        limit: read.limit,
      };
    case "page_mention_destination":
      return {
        kind: read.mode,
        page_id: read.pageId,
      };
    case "page_reference_candidates":
      return {
        kind: "page_reference_candidates",
        query: read.query,
        limit: read.limit ?? null,
        source_page_id: read.sourcePageId ?? null,
      };
    case "page_backlinks":
      return {
        kind: "page_backlinks",
        target_page_id: read.targetPageId,
        cursor: read.cursor ?? null,
        limit: read.limit ?? null,
      };
    case "page_files":
      return {
        kind: "page_files",
        page_id: read.pageId,
        query: read.query ?? null,
        cursor: read.cursor ?? null,
        limit: read.limit ?? null,
        include_deleted: read.includeDeleted ?? null,
      };
    case "page_file_metadata":
      return {
        kind: "page_file_metadata",
        page_id: read.pageId,
        file_id: read.fileId,
      };
    case "page_file_versions":
      return {
        kind: "page_file_versions",
        page_id: read.pageId,
        file_id: read.fileId,
        cursor: read.cursor ?? null,
        limit: read.limit ?? null,
      };
  }
};

type StructuralEditCommand = Extract<
  LibraryApplyOperation,
  { readonly kind: "apply_structural_edit" }
>["command"];
type CoreStructuralEditCommand = Extract<
  LibraryIntent,
  { readonly kind: "apply_structural_edit" }
>["command"];
type CoreStructuralReplacementBlock = Extract<
  Extract<CoreStructuralEditCommand, { readonly kind: "replace_selection" }>["replacement"],
  { readonly kind: "blocks" }
>["blocks"][number];

const toCoreStructuralClipboardToken = (
  token: Extract<StructuralEditCommand, { readonly kind: "paste_clipboard" }>["bundle"],
) => ({
  bundle_id: token.bundleId,
  capability: token.capability,
  manifest_hash: token.manifestHash,
  store_epoch: token.storeEpoch,
});

const toCoreStructuralSelection = (
  selection: Extract<StructuralEditCommand, { readonly kind: "capture_clipboard" }>["selection"],
) => ({
  source_document_id: selection.sourceDocumentId,
  root_block_ids: [...selection.rootBlockIds],
  source_head: {
    document_id: selection.sourceHead.documentId,
    generation: selection.sourceHead.generation,
    head_seq: selection.sourceHead.expectedHeadSeq,
  },
});

const toCoreStructuralTarget = (
  target: Extract<StructuralEditCommand, { readonly kind: "paste_clipboard" }>["target"],
) => ({
  target_document_id: target.targetDocumentId,
  parent_block_id: target.parentBlockId,
  before_block_id: target.beforeBlockId,
  target_head: {
    document_id: target.targetHead.documentId,
    generation: target.targetHead.generation,
    head_seq: target.targetHead.expectedHeadSeq,
  },
});

const toCoreStructuralReplacementBlock = (
  block: LibraryStructuralReplacementBlock,
): CoreStructuralReplacementBlock => ({
  block_type: block.blockType,
  props: { ...block.props },
  content: block.content,
  children: block.children.map(toCoreStructuralReplacementBlock),
});

const toCoreStructuralCommand = (command: StructuralEditCommand) => {
  switch (command.kind) {
    case "capture_clipboard":
      return {
        kind: command.kind,
        selection: toCoreStructuralSelection(command.selection),
      } as const;
    case "delete_selection":
      return {
        kind: command.kind,
        selection: toCoreStructuralSelection(command.selection),
        reason:
          command.reason.kind === "delete"
            ? { kind: "delete" as const }
            : {
                kind: "cut" as const,
                bundle: toCoreStructuralClipboardToken(command.reason.bundle),
              },
        direction: command.direction,
      } as const;
    case "paste_clipboard":
      return {
        kind: command.kind,
        bundle: toCoreStructuralClipboardToken(command.bundle),
        target: toCoreStructuralTarget(command.target),
      } as const;
    case "duplicate_selection":
    case "move_selection":
      return {
        kind: command.kind,
        selection: toCoreStructuralSelection(command.selection),
        target: toCoreStructuralTarget(command.target),
      } as const;
    case "replace_selection":
      return {
        kind: command.kind,
        selection: toCoreStructuralSelection(command.selection),
        replacement:
          command.replacement.kind === "clipboard"
            ? {
                kind: "clipboard" as const,
                bundle: toCoreStructuralClipboardToken(command.replacement.bundle),
              }
            : {
                kind: "blocks" as const,
                blocks: command.replacement.blocks.map(toCoreStructuralReplacementBlock),
              },
      } as const;
    case "turn_selection_into":
      return {
        kind: command.kind,
        selection: toCoreStructuralSelection(command.selection),
        target: command.target,
      } as const;
    case "merge_block_backward":
      return {
        kind: command.kind,
        selection: toCoreStructuralSelection(command.selection),
        target_block_id: command.targetBlockId,
      } as const;
    case "release_history":
      return {
        kind: command.kind,
        tokens: command.tokens.map((token) => ({
          recipe_operation_id: token.recipeOperationId,
          recipe_hash: token.recipeHash,
          store_epoch: token.storeEpoch,
        })),
      } as const;
  }
};

const toCoreIntent = (operation: LibraryApplyOperation): LibraryIntent => {
  switch (operation.kind) {
    case "create_page":
      return {
        kind: operation.kind,
        page_id: operation.pageId,
        document_id: operation.documentId,
        title: operation.title,
        parent: toCoreWriteParent(operation.parent),
      };
    case "create_page_mention":
      return {
        kind: operation.kind,
        page_id: operation.pageId,
        document_id: operation.documentId,
        title: operation.title,
        mention_host: {
          page_id: operation.mentionHost.pageId,
          document_id: operation.mentionHost.documentId,
          expected_document_generation: operation.mentionHost.expectedDocumentGeneration,
          expected_document_head_seq: operation.mentionHost.expectedDocumentHeadSeq,
          block_id: operation.mentionHost.blockId,
          expected_content: operation.mentionHost.expectedContent,
          replacement_content: operation.mentionHost.replacementContent,
        },
        destination: {
          page_id: operation.destination.pageId,
          document_id: operation.destination.documentId,
          expected_document_generation: operation.destination.expectedDocumentGeneration,
          expected_document_head_seq: operation.destination.expectedDocumentHeadSeq,
          insertion: toCorePageInsertion(operation.destination.insertion),
        },
      };
    case "create_database":
      return {
        kind: operation.kind,
        database_id: operation.databaseId,
        data_source_id: operation.dataSourceId,
        view_id: operation.viewId,
        name: operation.name,
        parent: toCoreWriteParent(operation.parent),
      };
    case "create_canvas":
      return {
        kind: operation.kind,
        canvas_id: operation.canvasId,
        document_id: operation.documentId,
        display_name: operation.displayName,
        destination: toCoreCanvasDestination(operation.destination),
      };
    case "rename_canvas":
      return {
        kind: operation.kind,
        canvas_id: operation.canvasId,
        display_name: operation.displayName,
        expected_metadata_revision: operation.expectedMetadataRevision,
      };
    case "move_canvas":
      return {
        kind: operation.kind,
        canvas_id: operation.canvasId,
        expected_location_revision: operation.expectedLocationRevision,
        destination: toCoreCanvasDestination(operation.destination),
      };
    case "duplicate_canvas":
      return {
        kind: operation.kind,
        source_canvas_id: operation.sourceCanvasId,
        canvas_id: operation.canvasId,
        document_id: operation.documentId,
        display_name: operation.displayName ?? null,
        expected_document_generation: operation.expectedDocumentGeneration,
        expected_document_head_seq: operation.expectedDocumentHeadSeq,
        destination: toCoreCanvasDestination(operation.destination),
      };
    case "delete_canvas":
      return {
        kind: operation.kind,
        canvas_id: operation.canvasId,
        expected_location_revision: operation.expectedLocationRevision,
        expected_metadata_revision: operation.expectedMetadataRevision,
        containing_document_head: operation.containingDocumentHead
          ? {
              document_id: operation.containingDocumentHead.documentId,
              generation: operation.containingDocumentHead.generation,
              head_seq: operation.containingDocumentHead.expectedHeadSeq,
            }
          : null,
      };
    case "move_block":
      return {
        kind: operation.kind,
        target:
          operation.target.kind === "page"
            ? { kind: "page", page_id: operation.target.pageId }
            : { kind: "database", database_id: operation.target.databaseId },
        expected_location_revision: operation.target.expectedLocationRevision,
        parent: toCoreWriteParent(operation.parent),
      };
    case "archive_resource":
    case "restore_resource":
      return {
        kind: operation.kind,
        target:
          operation.target.kind === "page"
            ? { kind: "page", page_id: operation.target.pageId }
            : { kind: "database", database_id: operation.target.databaseId },
        expected_metadata_revision: operation.target.expectedMetadataRevision,
      };
    case "grant_project_access":
      return {
        kind: operation.kind,
        project_id: operation.projectId,
        target: toCoreResourceTarget(operation.target),
        access: operation.access,
      };
    case "set_project_access":
      return {
        kind: operation.kind,
        target: toCoreResourceTarget(operation.target),
        changes: operation.changes.map((change) => ({
          project_id: change.projectId,
          access: change.access,
          expected_revision: change.expectedRevision,
        })),
      };
    case "apply_page_metadata_properties":
      return {
        kind: operation.kind,
        database_intents: operation.databaseOperations.map(toCoreDatabaseIntent),
        intrinsic_mutation: toCoreBlockPropertyMutation(
          operation.intrinsicFields,
          { kind: "page_metadata" },
          operation.clientSessionId,
        ),
      };
    case "apply_page_file_changes":
      return {
        kind: operation.kind,
        page_id: operation.pageId,
        expected_manifest_revision: operation.expectedManifestRevision,
        turn_id: operation.turnId ?? null,
        changes: operation.changes.map((change) => {
          switch (change.kind) {
            case "create":
              return {
                kind: change.kind,
                file_id: change.fileId,
                logical_path: change.logicalPath,
                mime_type: change.mimeType,
                prepared_blob_receipt_id: change.preparedBlobReceiptId,
                collision_policy: change.collisionPolicy,
              };
            case "replace_content":
              return {
                kind: change.kind,
                file_id: change.fileId,
                expected_version: change.expectedVersion,
                mime_type: change.mimeType,
                prepared_blob_receipt_id: change.preparedBlobReceiptId,
              };
            case "rename":
              return {
                kind: change.kind,
                file_id: change.fileId,
                expected_version: change.expectedVersion,
                logical_path: change.logicalPath,
              };
            case "delete":
              return {
                kind: change.kind,
                file_id: change.fileId,
                expected_version: change.expectedVersion,
              };
            case "restore_version":
              return {
                kind: change.kind,
                file_id: change.fileId,
                expected_version: change.expectedVersion,
                source_version: change.sourceVersion,
              };
            case "clone_into_page":
              return {
                kind: change.kind,
                source_page_id: change.sourcePageId,
                source_file_id: change.sourceFileId,
                target_file_id: change.targetFileId,
                logical_path: change.logicalPath,
              };
          }
        }),
      };
    case "apply_structural_edit":
      return {
        kind: operation.kind,
        command: toCoreStructuralCommand(operation.command),
      };
    case "reverse_structural_edit":
      return {
        kind: operation.kind,
        token: {
          recipe_operation_id: operation.token.recipeOperationId,
          recipe_hash: operation.token.recipeHash,
          store_epoch: operation.token.storeEpoch,
        },
      };
  }
};

type CorePageLifecycleMutation = Extract<
  LibraryIntent,
  { kind: "apply_page_lifecycle" }
>["mutation"];

const toCorePageLifecycleMutation = (
  operation: PageLifecycleOperationV2,
): CorePageLifecycleMutation => {
  switch (operation.kind) {
    case "create_page":
      return {
        kind: operation.kind,
        page_id: operation.pageId,
        title: operation.title,
        rich_title: operation.richTitle ?? null,
        nfm: operation.nfm,
        status: operation.status,
        priority: operation.priority,
        estimate: operation.estimate,
        due_date: operation.dueDate,
        scheduled_start: operation.scheduledStart,
        scheduled_end: operation.scheduledEnd,
        is_all_day: operation.isAllDay,
        recurrence: operation.recurrence,
        reminders: [...operation.reminders],
        schedule_timezone: operation.scheduleTimezone,
        assignee: operation.assignee,
        run_in_target: operation.runInTarget,
        run_in_local_path: operation.runInLocalPath,
        run_in_base_branch: operation.runInBaseBranch,
        run_in_worktree_path: operation.runInWorktreePath,
        run_in_environment_path: operation.runInEnvironmentPath,
        before_block_id: operation.beforeBlockId ?? null,
        view_placement:
          operation.viewPlacement.kind === "before"
            ? {
                kind: operation.viewPlacement.kind,
                page_id: operation.viewPlacement.pageId,
              }
            : { kind: operation.viewPlacement.kind },
        data_source_id: operation.dataSourceId,
        tag_option_ids: [...operation.tagOptionIds],
        new_tag_options: operation.newTagOptions.map((option) => ({
          option_id: option.optionId,
          name: option.name,
        })),
        expected_tags_property_revision: operation.expectedTagsPropertyRevision,
      };
    case "archive_page":
    case "unarchive_page":
      return {
        kind: operation.kind,
        page_id: operation.pageId,
        expected_metadata_revision: operation.expectedMetadataRevision,
      };
    case "delete_page":
      return {
        kind: operation.kind,
        page_id: operation.pageId,
        expected_metadata_revision: operation.expectedMetadataRevision,
        expected_parent_revision: operation.expectedParentRevision,
        parent_document_head: operation.parentDocumentHead
          ? {
              document_id: operation.parentDocumentHead.documentId,
              generation: operation.parentDocumentHead.generation,
              head_seq: operation.parentDocumentHead.expectedHeadSeq,
            }
          : null,
      };
    case "restore_page":
      return {
        kind: operation.kind,
        page_id: operation.pageId,
        delete_operation_id: operation.deleteOperationId,
        expected_metadata_revision: operation.expectedMetadataRevision,
        expected_parent_revision: operation.expectedParentRevision,
        membership: operation.membership
          ? {
              membership_id: operation.membership.membershipId,
              database_id: operation.membership.databaseId,
              data_source_id: operation.membership.dataSourceId,
              status: operation.membership.status,
              position: operation.membership.position
                ? {
                    view_id: operation.membership.position.viewId,
                    before_view_page_id: operation.membership.position.beforeViewPageId ?? null,
                  }
                : null,
            }
          : null,
        before_block_id: operation.beforeBlockId ?? null,
        parent_document_head: operation.parentDocumentHead
          ? {
              document_id: operation.parentDocumentHead.documentId,
              generation: operation.parentDocumentHead.generation,
              head_seq: operation.parentDocumentHead.expectedHeadSeq,
            }
          : null,
      };
    case "move_page_in_library":
      return {
        kind: operation.kind,
        page_id: operation.pageId,
        expected_parent_revision: operation.expectedParentRevision,
        before_block_id: operation.beforeBlockId ?? null,
      };
  }
};

type CoreRouteTarget = Extract<LibraryReadSnapshot["value"], { kind: "path" }>["target"];
type CoreNavigationParent = Extract<LibraryReadSnapshot["value"], { kind: "children" }>["parent"];
type CoreNavigationNode = Extract<
  LibraryReadSnapshot["value"],
  { kind: "children" | "standalone_roots" }
>["items"][number];
type CorePageDetail = Extract<LibraryReadSnapshot["value"], { kind: "page_detail" }>["value"];
type CorePageHistory = Extract<LibraryReadSnapshot["value"], { kind: "page_history" }>["value"];
type CorePageHistoryCursor = NonNullable<CorePageHistory["next_cursor"]>;
type CorePageHistoryEntry = CorePageHistory["entries"][number];
type CorePageTarget = NonNullable<
  Extract<LibraryReadSnapshot["value"], { kind: "page_target" }>["value"]
>;
type CorePageOwnershipPath = NonNullable<
  Extract<LibraryReadSnapshot["value"], { kind: "page_ownership_path" }>["value"]
>;
type CorePageLifecyclePreflight = Extract<
  LibraryReadSnapshot["value"],
  { kind: "page_lifecycle_preflight" }
>["value"];

const fromCoreRouteTarget = (target: CoreRouteTarget): LibraryRouteTarget => {
  if (target.kind === "page") return { kind: target.kind, pageId: target.page_id };
  if (target.kind === "database") {
    return { kind: target.kind, databaseId: parseDatabaseId(target.database_id) };
  }
  if (target.kind === "canvas") {
    return { kind: target.kind, canvasId: target.canvas_id };
  }
  return { kind: target.kind, viewId: parseDatabaseViewId(target.view_id) };
};

const fromCoreParent = (parent: CoreNavigationParent): LibraryNavigationParent => {
  if (parent.kind === "library") return parent;
  if (parent.kind === "page") return { kind: parent.kind, pageId: parent.page_id };
  return { kind: parent.kind, databaseId: parseDatabaseId(parent.database_id) };
};

const parseViewLayout = (value: string): DatabaseViewLayout => {
  if (value === "board" || value === "list") {
    return value;
  }
  throw new Error(`Core returned unsupported Database View layout ${value}`);
};

const fromCoreNode = (node: CoreNavigationNode): LibraryNavigationNode => {
  if (node.kind === "page") {
    return {
      kind: node.kind,
      pageId: node.page_id,
      title: node.title,
      hasChildren: node.has_children,
      parentRevision: node.parent_revision,
      metadataRevision: node.metadata_revision,
      documentGeneration: node.document_generation,
      documentHeadSeq: node.document_head_seq,
      updatedAt: node.updated_at,
    };
  }
  if (node.kind === "database") {
    return {
      kind: node.kind,
      databaseId: parseDatabaseId(node.database_id),
      title: node.title,
      defaultViewId: parseDatabaseViewId(node.default_view_id),
      hasMultipleViews: node.has_multiple_views,
      metadataRevision: node.metadata_revision,
      locationRevision: node.location_revision,
      updatedAt: node.updated_at,
    };
  }
  if (node.kind === "canvas") {
    return {
      kind: node.kind,
      canvasId: node.canvas_id,
      title: node.title,
      isPrimary: node.is_primary,
      metadataRevision: node.metadata_revision,
      locationRevision: node.location_revision,
      documentGeneration: node.document_generation,
      documentHeadSeq: node.document_head_seq,
      updatedAt: node.updated_at,
    };
  }
  return {
    kind: node.kind,
    viewId: parseDatabaseViewId(node.view_id),
    databaseId: parseDatabaseId(node.database_id),
    dataSourceId: parseDataSourceId(node.data_source_id),
    title: node.title,
    defaultLayout: parseViewLayout(node.default_layout),
    isDefault: node.is_default,
    revision: node.revision,
  };
};

const mapReadValue = (snapshot: LibraryReadSnapshot): LibraryReadValue => {
  const value = snapshot.value;
  switch (value.kind) {
    case "metadata":
      return { kind: value.kind } as const;
    case "resource_project_access":
      return {
        kind: value.kind,
        value: {
          target:
            value.value.target.kind === "page"
              ? { kind: "page" as const, pageId: value.value.target.page_id }
              : value.value.target.kind === "database"
                ? {
                    kind: "database" as const,
                    databaseId: parseDatabaseId(value.value.target.database_id),
                  }
                : (() => {
                    throw new Error("Canvas access is inherited and cannot be managed directly");
                  })(),
          projects: value.value.projects.map((project) => ({
            projectId: project.project_id,
            projectName: project.project_name,
            appearance: project.appearance,
            lifecycle: project.lifecycle,
            directGrant: project.direct_grant
              ? {
                  access: project.direct_grant.access,
                  revision: project.direct_grant.revision,
                }
              : null,
            inheritedSources: project.inherited_sources.map((source) => {
              if (source.kind === "ancestor_page") {
                return {
                  kind: source.kind,
                  pageId: source.page_id,
                  pageTitle: source.page_title,
                  access: source.access,
                } as const;
              }
              return {
                kind: source.kind,
                databaseId: parseDatabaseId(source.database_id),
                databaseName: source.database_name,
                access: source.access,
              } as const;
            }),
            effectiveAccess: project.effective_access ?? null,
          })),
        },
      } as const;
    case "canvas_target":
      return {
        kind: value.kind,
        value:
          value.value.status === "available"
            ? {
                status: value.value.status,
                summary: {
                  canvasId: value.value.summary.canvas_id,
                  title: value.value.summary.title,
                  lifecycle: value.value.summary.lifecycle,
                  isPrimary: value.value.summary.is_primary,
                  location:
                    value.value.summary.location.kind === "library"
                      ? { kind: "library" as const }
                      : {
                          kind: "page" as const,
                          pageId: value.value.summary.location.page_id,
                          documentId: value.value.summary.location.document_id,
                        },
                  metadataRevision: value.value.summary.metadata_revision,
                  locationRevision: value.value.summary.location_revision,
                  documentGeneration: value.value.summary.document_generation,
                  documentHeadSeq: value.value.summary.document_head_seq,
                  updatedAt: value.value.summary.updated_at,
                },
              }
            : value.value.status === "deleted"
              ? {
                  status: value.value.status,
                  canvasId: value.value.canvas_id,
                  libraryId: value.value.library_id,
                }
              : {
                  status: value.value.status,
                  canvasId: value.value.canvas_id,
                },
      } as const;
    case "children":
      return {
        kind: value.kind,
        parent: fromCoreParent(value.parent),
        items: value.items.map(fromCoreNode),
        nextCursor: value.next_cursor ?? null,
        hasMore: value.has_more,
        total: value.total,
      } as const;
    case "standalone_roots":
      return {
        kind: value.kind,
        items: value.items.map(fromCoreNode).filter((node) => node.kind !== "view"),
        nextCursor: value.next_cursor ?? null,
        hasMore: value.has_more,
        total: value.total,
      } as const;
    case "path":
      return {
        kind: value.kind,
        target: fromCoreRouteTarget(value.target),
        nodes: value.nodes.map(fromCoreNode),
      } as const;
    case "catalog":
      return {
        kind: value.kind,
        items: value.items.map((item) => ({
          target:
            item.target.kind === "page"
              ? { kind: "page" as const, pageId: item.target.page_id }
              : item.target.kind === "database"
                ? {
                    kind: "database" as const,
                    databaseId: parseDatabaseId(item.target.database_id),
                  }
                : {
                    kind: "canvas" as const,
                    canvasId: item.target.canvas_id,
                  },
          title: item.title,
          kind: item.kind,
          lifecycle: item.lifecycle,
          locationLabel: item.location_label,
          updatedAt: item.updated_at,
          locationRevision: item.location_revision,
          metadataRevision: item.metadata_revision,
        })),
        nextCursor: value.next_cursor ?? null,
        hasMore: value.has_more,
        total: value.total,
      } as const;
    case "move_destinations":
      return {
        kind: value.kind,
        target:
          value.target.kind === "page"
            ? { kind: "page" as const, pageId: value.target.page_id }
            : value.target.kind === "database"
              ? {
                  kind: "database" as const,
                  databaseId: parseDatabaseId(value.target.database_id),
                }
              : {
                  kind: "canvas" as const,
                  canvasId: value.target.canvas_id,
                },
        scope:
          value.scope.kind === "suggested"
            ? value.scope
            : value.scope.kind === "search"
              ? value.scope
              : {
                  kind: value.scope.kind,
                  parent: (() => {
                    const parent = fromCoreParent(value.scope.parent);
                    if (parent.kind === "database") {
                      throw new Error("Core returned a Database move destination scope");
                    }
                    return parent;
                  })(),
                },
        items: value.items.map((item) => ({
          pageId: item.page_id,
          title: item.title,
          path: item.path,
          hasChildren: item.has_children,
          isCurrent: item.is_current,
          documentGeneration: item.document_generation,
          documentHeadSeq: item.document_head_seq,
          updatedAt: item.updated_at,
        })),
        currentDestination: value.current_destination
          ? {
              pageId: value.current_destination.page_id,
              title: value.current_destination.title,
              path: value.current_destination.path,
              hasChildren: value.current_destination.has_children,
              isCurrent: value.current_destination.is_current,
              documentGeneration: value.current_destination.document_generation,
              documentHeadSeq: value.current_destination.document_head_seq,
              updatedAt: value.current_destination.updated_at,
            }
          : null,
        nextCursor: value.next_cursor ?? null,
        hasMore: value.has_more,
        total: value.total,
        rootIsCurrent: value.root_is_current,
      } as const;
    case "page_mention_destination":
      return {
        kind: value.kind,
        value: {
          pageId: value.value.page_id,
          documentId: value.value.document_id,
          documentGeneration: value.value.document_generation,
          documentHeadSeq: value.value.document_head_seq,
        },
      } as const;
    case "page_reference_candidates":
      return {
        kind: value.kind,
        items: value.items.map((item) => ({
          pageId: item.page_id,
          title: item.title,
          pageKey: item.page_key ?? null,
          status: item.status ?? null,
          locationLabel: item.location_label,
          matchExcerpt: item.match_excerpt ?? null,
          matchSource: item.match_source,
          titleParts: mapPageSearchParts(item.title_parts),
          matchExcerptParts: mapPageSearchParts(item.match_excerpt_parts),
          matches: item.matches.map(mapPageSearchMatch),
        })),
      } as const;
    case "page_backlinks":
      return {
        kind: value.kind,
        targetPageId: value.target_page_id,
        items: value.items.map((item) => ({
          sourcePageId: item.source_page_id,
          sourceBlockId: item.source_block_id,
          sourceTitle: item.source_title,
          locationLabel: item.location_label,
          presentations: item.presentations,
          occurrenceCount: item.occurrence_count,
          updatedAt: item.updated_at,
        })),
        nextCursor: value.next_cursor ?? null,
        hasMore: value.has_more,
        total: value.total,
        sourcePageCount: value.source_page_count,
      } as const;
    case "page_files":
      return {
        kind: value.kind,
        value: {
          pageId: value.value.page_id,
          revision: value.value.revision,
          bodyUsageRevision: value.value.body_usage_revision,
          files: value.value.files.map(mapPageFileSummary),
          nextCursor: value.value.next_cursor ?? null,
          hasMore: value.value.has_more,
          total: value.value.total,
          liveTotal: value.value.live_total,
          unplacedTotal: value.value.unplaced_total,
          placedTotal: value.value.placed_total,
          deletedTotal: value.value.deleted_total,
        },
      } as const;
    case "page_file_metadata":
      return {
        kind: value.kind,
        value: mapPageFileSummary(value.value),
      } as const;
    case "page_file_versions":
      return {
        kind: value.kind,
        value: {
          pageId: value.value.page_id,
          fileId: value.value.file_id,
          versions: value.value.versions.map((version) => ({
            fileId: version.file_id,
            version: version.version,
            ownerPageId: version.owner_page_id,
            manifestRevision: version.manifest_revision,
            changeKind: version.change_kind,
            logicalPath: version.logical_path,
            mimeType: version.mime_type,
            byteLength: version.byte_length,
            blobEtag: version.blob_etag ?? null,
            actorId: version.actor_id,
            turnId: version.turn_id ?? null,
            operationId: version.operation_id,
            occurredAt: version.occurred_at,
          })),
          nextCursor: value.value.next_cursor ?? null,
          hasMore: value.value.has_more,
        },
      } as const;
    default:
      throw new Error(`Core Library read ${value.kind} cannot satisfy the catalog Adapter`);
  }
};

const mapPageFileSummary = (file: {
  readonly file_id: string;
  readonly owner_page_id: string;
  readonly logical_path: string;
  readonly mime_type: string;
  readonly byte_length: number;
  readonly version: number;
  readonly blob_etag: string;
  readonly state: "live" | "deleted";
  readonly created_by_actor_id: string;
  readonly created_by_turn_id?: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly body_usage:
    | { readonly kind: "not_in_body" }
    | { readonly kind: "placed"; readonly placement_count: number };
}) => ({
  fileId: file.file_id,
  ownerPageId: file.owner_page_id,
  logicalPath: file.logical_path,
  mimeType: file.mime_type,
  byteLength: file.byte_length,
  version: file.version,
  blobEtag: file.blob_etag,
  state: file.state,
  createdByActorId: file.created_by_actor_id,
  createdByTurnId: file.created_by_turn_id ?? null,
  createdAt: file.created_at,
  updatedAt: file.updated_at,
  bodyUsage:
    file.body_usage.kind === "placed"
      ? { kind: file.body_usage.kind, placementCount: file.body_usage.placement_count }
      : { kind: file.body_usage.kind },
});

const mapPageDataSourceContext = (context: CorePageDetail["data_source_context"]): unknown => {
  if (context.kind === "standalone") return { kind: "standalone" };
  return {
    kind: "member",
    pageKey: context.page_key ?? null,
    membership: {
      membershipId: context.membership.membership_id,
      dataSourceId: context.membership.data_source_id,
      revision: context.membership.revision,
      createdAt: context.membership.created_at,
    },
    database: context.database,
    dataSource: context.data_source,
    properties: context.properties.map(mapCorePropertyDescriptor),
    values: context.values,
  };
};

const mapPageDetail = (
  detail: CorePageDetail,
  authorization: NonNullable<LibraryReadSnapshot["authorization"]>,
): Readonly<Record<string, unknown>> => ({
  libraryId: detail.library_id,
  storeEpoch: detail.store_epoch,
  commitSeq: detail.commit_seq,
  authorization,
  page: detail.page,
  document: {
    readiness: detail.document.readiness,
    schemaKey: detail.document.schema_key,
    schemaVersion: detail.document.schema_version,
  },
  intrinsicProperties: detail.intrinsic_properties.map((property) => ({
    key: property.key,
    valueType: property.value_type,
    value: property.value,
    revision: property.revision,
  })),
  dataSourceContext: mapPageDataSourceContext(detail.data_source_context),
});

const mapPageHistoryCursor = (cursor: CorePageHistoryCursor): Readonly<Record<string, unknown>> => {
  if (cursor.source === "document_version") {
    return {
      occurredAt: cursor.occurred_at,
      source: cursor.source,
      versionId: cursor.version_id,
    };
  }
  return {
    occurredAt: cursor.occurred_at,
    source: cursor.source,
    changeSeq: cursor.change_seq,
  };
};

const mapPageHistoryEntryBase = (
  entry: CorePageHistoryEntry,
): Readonly<Record<string, unknown>> => ({
  id: entry.id,
  libraryId: entry.library_id,
  pageId: entry.page_id,
  documentId: entry.document_id,
  occurredAt: entry.occurred_at,
  display: {
    category: entry.display.category,
    title: entry.display.title,
    detail: entry.display.detail ?? null,
    actorLabel: entry.display.actor_label ?? null,
  },
  evidence: entry.evidence,
  recovery:
    entry.recovery.kind === "restore_document_version"
      ? {
          kind: entry.recovery.kind,
          documentId: entry.recovery.document_id,
          versionId: entry.recovery.version_id,
        }
      : entry.recovery,
});

const mapPageHistoryEntry = (entry: CorePageHistoryEntry): Readonly<Record<string, unknown>> => {
  const base = mapPageHistoryEntryBase(entry);
  if (entry.kind === "document_version") {
    return {
      ...base,
      kind: entry.kind,
      versionMetadata: {
        versionId: entry.version_metadata.version_id,
        generation: entry.version_metadata.generation,
        baseHeadSeq: entry.version_metadata.base_head_seq,
        schemaKey: entry.version_metadata.schema_key,
        schemaVersion: entry.version_metadata.schema_version,
        cause: entry.version_metadata.cause,
        label: entry.version_metadata.label ?? null,
        revisionKind: entry.version_metadata.revision_kind,
        sourceMutationId: entry.version_metadata.source_mutation_id ?? null,
        sourceChangeSeq: entry.version_metadata.source_change_seq ?? null,
        pinned: entry.version_metadata.pinned,
        checkpointHash: entry.version_metadata.checkpoint_hash,
        byteLength: entry.version_metadata.byte_length,
      },
    };
  }
  if (entry.kind === "block_mutation") {
    return {
      ...base,
      kind: entry.kind,
      changeSeq: entry.change_seq,
      mutationId: entry.mutation_id ?? null,
      mutationKind: entry.mutation_kind ?? null,
      affectedBlockCount: entry.affected_block_count ?? null,
      fieldIntentCount: entry.field_intent_count ?? null,
    };
  }
  return {
    ...base,
    kind: entry.kind,
    changeSeq: entry.change_seq,
    relocationId: entry.relocation_id ?? null,
    direction: entry.direction,
    movedBlockCount: entry.moved_block_count ?? null,
  };
};

const mapPageHistory = (page: CorePageHistory): Readonly<Record<string, unknown>> => ({
  libraryId: page.library_id,
  pageId: page.page_id,
  documentId: page.document_id,
  entries: page.entries.map(mapPageHistoryEntry),
  nextCursor: page.next_cursor ? mapPageHistoryCursor(page.next_cursor) : null,
});

type CoreProjectPageSearchValue = Extract<
  LibraryReadSnapshot["value"],
  { readonly kind: "project_page_search" }
>;
type CorePageSearchMatch = CoreProjectPageSearchValue["items"][number]["matches"][number];
type CorePageSearchOption = CoreProjectPageSearchValue["items"][number]["tags"][number];
type CoreProjectPageSearchMetadataValue = Extract<
  LibraryReadSnapshot["value"],
  { readonly kind: "project_page_search_metadata" }
>;
type CorePageSearchMetadataItem = CoreProjectPageSearchMetadataValue["items"][number];

const mapPageSearchParts = (
  parts: readonly { readonly text: string; readonly highlighted: boolean }[],
): PageSearchTextPart[] =>
  parts.map((part) => ({
    text: part.text,
    highlighted: part.highlighted,
  }));

const mapPageSearchMatch = (match: CorePageSearchMatch): PageSearchMatch => {
  const parts = mapPageSearchParts(match.parts);
  if (match.source === "page_key") {
    return {
      source: match.source,
      quality: match.quality,
      pageKey: match.page_key,
      isCurrent: match.is_current,
      parts,
    };
  }
  if (match.source === "property") {
    return {
      source: match.source,
      quality: match.quality,
      propertyId: match.property_id,
      propertyName: match.property_name,
      parts,
    };
  }
  if (match.source === "body") {
    return {
      source: match.source,
      quality: match.quality,
      blockId: match.block_id,
      blockType: match.block_type,
      parts,
    };
  }
  return { source: match.source, quality: match.quality, parts };
};

function validatePageSearchMetadataItem(item: CorePageSearchMetadataItem): void {
  if (typeof item.page_id !== "string" || item.page_id.length === 0) {
    throw new Error("Core Page search metadata returned an invalid page_id");
  }
  if (typeof item.title !== "string" || typeof item.preview !== "string") {
    throw new Error("Core Page search metadata returned invalid title or preview");
  }
  if (item.page_key !== null && typeof item.page_key !== "string") {
    throw new Error("Core Page search metadata returned an invalid page_key");
  }
  if (item.status !== null && !isWorkflowStatus(item.status)) {
    throw new Error("Core Page search metadata returned an invalid status");
  }
  if (item.priority !== null && !isPriority(item.priority)) {
    throw new Error("Core Page search metadata returned an invalid priority");
  }
  if (typeof item.location_label !== "string" || typeof item.updated_at !== "string") {
    throw new Error("Core Page search metadata returned invalid location or timestamp");
  }
  if (item.assignee !== null && typeof item.assignee !== "string") {
    throw new Error("Core Page search metadata returned an invalid assignee");
  }
  if (!Array.isArray(item.tags) || !Array.isArray(item.properties)) {
    throw new Error("Core Page search metadata returned invalid property collections");
  }
  if (
    !Array.isArray(item.authorized_project_ids) ||
    item.authorized_project_ids.some(
      (projectId) => typeof projectId !== "string" || projectId.length === 0,
    ) ||
    !Array.isArray(item.data_source_ids) ||
    item.data_source_ids.some(
      (dataSourceId) => typeof dataSourceId !== "string" || dataSourceId.length === 0,
    )
  ) {
    throw new Error("Core Page search metadata returned invalid authorization scope");
  }
}

const mapPageSearchOption = (option: CorePageSearchOption): PageSearchOption => ({
  dataSourceId: option.data_source_id,
  propertyId: option.property_id,
  optionId: option.option_id,
  label: option.label,
});

const mapPageTarget = (
  value: CorePageTarget,
  authority: {
    readonly libraryId: string;
    readonly storeEpoch: string;
    readonly commitSeq: number;
    readonly authorization: AuthorizedReadStamp | null;
  },
): PageTargetReadModel => {
  const base = authority;
  if (value.status === "missing") {
    return { ...base, status: value.status, targetPageId: value.target_page_id };
  }
  if (value.status === "invalid_target") {
    return {
      ...base,
      status: value.status,
      targetPageId: value.target_page_id,
      actualBlockType: value.actual_block_type,
    };
  }
  if (value.status === "deleted") {
    return {
      ...base,
      status: value.status,
      targetPageId: value.target_page_id,
      libraryId: value.library_id,
    };
  }
  const page = parsePage(value.page);
  if (page.pageId !== value.target_page_id || page.lifecycle === "deleted") {
    throw new Error("Core Page target escaped its requested active Page boundary");
  }
  const readiness = value.document.readiness;
  if (readiness !== "pending_genesis" && readiness !== "ready" && readiness !== "failed") {
    throw new Error("Core Page target returned invalid Document readiness");
  }
  return {
    ...base,
    status: value.status,
    targetPageId: value.target_page_id,
    page: { ...page, lifecycle: page.lifecycle },
    document: {
      readiness,
      schemaKey: value.document.schema_key,
      schemaVersion: value.document.schema_version,
    },
  };
};

const mapPageOwnershipPath = (
  value: CorePageOwnershipPath,
  authority: {
    readonly libraryId: string;
    readonly storeEpoch: string;
    readonly commitSeq: number;
    readonly authorization: AuthorizedReadStamp | null;
  },
): PageOwnershipPathReadModel => {
  if (value.status === "missing") {
    return { ...authority, status: value.status, targetPageId: value.target_page_id };
  }
  return {
    ...authority,
    status: value.status,
    targetPageId: value.target_page_id,
    ancestors: value.ancestors.map((ancestor) => ({
      pageId: ancestor.page_id,
      title: ancestor.title,
      lifecycle: ancestor.lifecycle,
    })),
  };
};

const coreRecord = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }
  throw new Error(`Core ${label} is not an object`);
};

const mapLifecycleTagsProperty = (value: unknown) => {
  const property = coreRecord(value, "Page lifecycle tags Property");
  return {
    propertyId: property.propertyId,
    dataSourceId: property.dataSourceId,
    valueType: property.valueType,
    lifecycle: property.lifecycle,
    revision: property.revision,
    config: property.config,
  };
};

const mapLifecycleDefaultView = (value: unknown): Readonly<Record<string, unknown>> => {
  const defaultView = coreRecord(value, "Page lifecycle default View");
  if (!Array.isArray(defaultView.properties)) {
    throw new Error("Core Page lifecycle default View has no Property descriptors");
  }
  return {
    ...defaultView,
    properties: defaultView.properties.map(mapCorePropertyDescriptor),
  };
};

const mapLifecycleParent = (
  parent: CorePageLifecyclePreflight["page"] extends infer Page
    ? NonNullable<Page> extends { parent: infer Parent }
      ? Parent
      : never
    : never,
) => {
  if (parent.kind === "library") {
    return { kind: parent.kind, libraryId: parent.library_id } as const;
  }
  if (parent.kind === "page") {
    return { kind: parent.kind, pageId: parent.page_id } as const;
  }
  return {
    kind: parent.kind,
    dataSourceId: parseDataSourceId(parent.data_source_id),
  } as const;
};

const mapLifecyclePage = (page: NonNullable<CorePageLifecyclePreflight["page"]>) => {
  if (!["active", "archived", "deleted"].includes(page.lifecycle)) {
    throw new Error("Core Page lifecycle preflight returned invalid lifecycle");
  }
  if (
    page.document.readiness !== "ready" ||
    page.document.authority !== "ydoc_primary" ||
    !isWorkflowStatus(page.membership?.status ?? "triage")
  ) {
    throw new Error("Core Page lifecycle preflight returned invalid authority");
  }
  const membership = page.membership
    ? {
        membershipId: page.membership.membership_id,
        databaseId: parseDatabaseId(page.membership.database_id),
        dataSourceId: parseDataSourceId(page.membership.data_source_id),
        membershipRevision: page.membership.membership_revision,
        viewId: parseDatabaseViewId(page.membership.view_id),
        viewRevision: page.membership.view_revision,
        statusPropertyId: page.membership.status_property_id,
        statusValueRevision: page.membership.status_value_revision,
        status: page.membership.status,
        position: page.membership.position
          ? {
              rankKey: page.membership.position.rank_key,
              revision: page.membership.position.revision,
            }
          : null,
      }
    : null;
  const restoreEvidence = page.restore_evidence
    ? {
        deleteOperationId: page.restore_evidence.delete_operation_id,
        previousLifecycle: page.restore_evidence.previous_lifecycle,
        membership: page.restore_evidence.membership
          ? {
              membershipId: page.restore_evidence.membership.membership_id,
              databaseId: parseDatabaseId(page.restore_evidence.membership.database_id),
              dataSourceId: parseDataSourceId(page.restore_evidence.membership.data_source_id),
              status: page.restore_evidence.membership.status,
              position: page.restore_evidence.membership.view_id
                ? {
                    viewId: parseDatabaseViewId(page.restore_evidence.membership.view_id),
                  }
                : null,
            }
          : null,
        nestedParent: page.restore_evidence.nested_parent
          ? {
              documentId: page.restore_evidence.nested_parent.document_id,
              parentBlockId: page.restore_evidence.nested_parent.parent_block_id ?? null,
              beforeBlockId: page.restore_evidence.nested_parent.before_block_id ?? null,
            }
          : null,
      }
    : null;
  return {
    pageId: page.page_id,
    lifecycle: page.lifecycle as "active" | "archived" | "deleted",
    parent: mapLifecycleParent(page.parent),
    libraryRankKey: page.library_rank_key ?? null,
    metadataRevision: page.metadata_revision,
    parentRevision: page.parent_revision,
    document: {
      documentId: page.document.document_id,
      generation: page.document.generation,
      headSeq: page.document.head_seq,
      readiness: page.document.readiness as "ready",
      authority: page.document.authority as "ydoc_primary",
      schemaKey: page.document.schema_key,
      schemaVersion: page.document.schema_version,
    },
    membership,
    restoreEvidence,
  };
};

const mapPageLifecyclePreflight = (input: CorePageLifecyclePreflight) => ({
  defaultView: mapLifecycleDefaultView(input.default_view),
  tagsProperty: mapLifecycleTagsProperty(input.tags_property),
  reservedBlockType: input.reserved_block_type ?? null,
  page: input.page ? mapLifecyclePage(input.page) : null,
});

const pageLifecyclePreflightFailure = (error: unknown): PageLifecyclePreflightResultV2 => {
  if (error instanceof CoreModuleResponseError) {
    const code = (() => {
      switch (error.coreError.code) {
        case "invalid_input":
          return "invalid_request";
        case "stale_store_epoch":
          return "store_not_initialized";
        case "not_found":
          return "page_not_found";
        case "unauthorized":
          return "authorization_denied";
        case "store_corrupt":
        case "invalid_document_schema":
          return "state_corrupt";
        default:
          return "unknown";
      }
    })() satisfies Extract<PageLifecyclePreflightResultV2, { readonly ok: false }>["error"]["code"];
    return {
      ok: false,
      error: {
        code,
        message: error.message,
        retryable: error.coreError.retryable,
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "unknown",
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    },
  };
};

const pageLifecycleMutationFailure = (
  request: PageLifecycleMutationRequestV2,
  error: unknown,
): PageLifecycleMutationCommandResultV2 => {
  const coreError = error instanceof CoreModuleResponseError ? error.coreError : null;
  const code = (() => {
    switch (coreError?.code) {
      case "invalid_input":
        return "invalid_page_lifecycle_request";
      case "stale_store_epoch":
        return "store_epoch_mismatch";
      case "idempotency_key_reused":
        return "operation_id_collision";
      case "not_found":
        return "page_not_found";
      case "unauthorized":
        return "authorization_denied";
      case "revision_conflict":
        return request.operation.kind === "move_page_in_library"
          ? "parent_revision_conflict"
          : "metadata_revision_conflict";
      case "store_corrupt":
      case "invalid_document_schema":
        return "document_state_corrupt";
      default:
        return "unknown";
    }
  })() satisfies PageLifecycleMutationErrorCodeV2;
  return parsePageLifecycleMutationCommandResultV2({
    ok: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
      retryable: coreError?.retryable ?? true,
      operationId: request.operationId,
      pageId: request.operation.pageId,
    },
  });
};

const mapCoreError = (error: CoreModuleError): LibraryModuleError => {
  const code = (() => {
    switch (error.code) {
      case "invalid_input":
        return "invalid_request";
      case "stale_store_epoch":
        return "store_epoch_mismatch";
      case "idempotency_key_reused":
        return "identity_conflict";
      case "not_found":
      case "unauthorized":
        return "resource_not_found";
      case "revision_conflict":
        return "revision_conflict";
      case "generation_conflict":
      case "head_conflict":
        return "document_conflict";
      case "store_corrupt":
        return "state_corrupt";
      case "resource_exhausted":
        return "resource_exhausted";
      case "protected_owner_deletion":
        return "file_in_use";
      default:
        return "unknown";
    }
  })() satisfies LibraryModuleError["code"];
  return { code, message: error.message, retryable: error.retryable };
};

const failure = (error: unknown): { readonly ok: false; readonly error: LibraryModuleError } => {
  if (error instanceof CoreModuleResponseError) {
    return { ok: false, error: mapCoreError(error.coreError) };
  }
  return {
    ok: false,
    error: {
      code: "unknown",
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    },
  };
};

const pageDetailError = (error: unknown): PageDetailError => {
  if (error instanceof CoreModuleResponseError) {
    const code = (() => {
      switch (error.coreError.code) {
        case "invalid_input":
          return "invalid_request";
        case "not_found":
          return "page_not_found";
        case "unauthorized":
          return "authorization_denied";
        case "store_corrupt":
        case "invalid_document_schema":
          return "page_detail_corrupt";
        default:
          return "unknown";
      }
    })() satisfies PageDetailError["code"];
    return {
      code,
      message: error.message,
      retryable: error.coreError.retryable,
    };
  }
  return {
    code: "unknown",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
};

const pageHistoryError = (error: unknown): PageHistoryCommandError => {
  if (error instanceof CoreModuleResponseError) {
    const code = (() => {
      switch (error.coreError.code) {
        case "invalid_input":
          return "invalid_page_history_request";
        case "not_found":
        case "unauthorized":
          return "page_not_found";
        case "store_corrupt":
        case "invalid_document_schema":
          return "page_history_corrupt";
        default:
          return "unknown";
      }
    })() satisfies PageHistoryCommandError["code"];
    return pageHistoryFailure(code, error.message, error.coreError.retryable);
  }
  return pageHistoryFailure(
    "unknown",
    error instanceof Error ? error.message : String(error),
    true,
  );
};

const fromCoreCreatedTarget = (
  target: NonNullable<Extract<LibraryIntent, { kind: "archive_resource" }>["target"]>,
): Exclude<LibraryRouteTarget, { kind: "view" }> => {
  if (target.kind === "page") return { kind: target.kind, pageId: target.page_id };
  if (target.kind === "database") {
    return { kind: target.kind, databaseId: parseDatabaseId(target.database_id) };
  }
  return { kind: target.kind, canvasId: target.canvas_id };
};

type CoreBlockPropertyMutation = Extract<
  LibraryIntent,
  { kind: "apply_block_property_mutation" }
>["mutation"];
type CoreBlockPropertyOutcome = NonNullable<
  Awaited<ReturnType<CoreClientPort["libraryApply"]>>["outcome"]["block_property_mutation"]
>["outcome"];

const toCoreBlockPropertyMutation = (
  fields: BlockPropertyMutationRequestV2["fields"],
  actor: BlockPropertyMutationRequestV2["actor"],
  clientSessionId: string | undefined,
): CoreBlockPropertyMutation => ({
  actor,
  client_session_id: clientSessionId ?? null,
  fields: fields.map((field) => ({
    kind: "intrinsic_set" as const,
    block_id: field.blockId,
    property_key: field.propertyKey,
    expected_revision: field.expectedRevision,
    value: field.value,
  })),
});

const fromCoreBlockPropertyField = (
  field: Extract<CoreBlockPropertyOutcome, { status: "committed" }>["fields"][number],
): BlockPropertyMutationFieldResultV2 => {
  if (field.scope !== "intrinsic") {
    throw new Error("Core returned retired Data Source Property mutation evidence");
  }
  return {
    path: field.path,
    scope: "intrinsic",
    blockId: field.block_id,
    propertyKey: field.property_key,
    operation: "set",
    revision: field.revision,
    value: field.value as BlockPropertyMutationFieldResultV2["value"],
  };
};

const blockPropertyFailure = (
  mutationId: string,
  error: unknown,
): BlockPropertyMutationCommandResultV2 => {
  const coreError = error instanceof CoreModuleResponseError ? error.coreError : null;
  const code = (() => {
    switch (coreError?.code) {
      case "invalid_input":
        return "invalid_property_mutation_request";
      case "stale_store_epoch":
        return "store_epoch_mismatch";
      case "idempotency_key_reused":
        return "mutation_id_collision";
      case "not_found":
        return "block_not_found";
      case "revision_conflict":
        return "property_conflict";
      default:
        return "unknown";
    }
  })() satisfies Extract<
    BlockPropertyMutationCommandResultV2,
    { readonly ok: false }
  >["error"]["code"];
  return {
    ok: false,
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
      retryable: coreError?.retryable ?? true,
      mutationId,
    },
  };
};

const fromCoreBlockPropertyOutcome = (
  mutationId: string,
  outcome: CoreBlockPropertyOutcome,
): Extract<BlockPropertyMutationCommandResultV2, { readonly ok: false }> | null => {
  if (outcome.status === "committed") return null;
  return {
    ok: false,
    error: {
      code: outcome.error.code,
      message: outcome.error.message,
      retryable: outcome.error.retryable,
      mutationId,
      ...(outcome.error.field_path === undefined || outcome.error.field_path === null
        ? {}
        : { fieldPath: outcome.error.field_path }),
      ...(outcome.error.expected_revision === undefined || outcome.error.expected_revision === null
        ? {}
        : { expectedRevision: outcome.error.expected_revision }),
      ...(outcome.error.actual_revision === undefined || outcome.error.actual_revision === null
        ? {}
        : { actualRevision: outcome.error.actual_revision }),
    },
  };
};

export const createCoreLibraryModuleAdapter = (
  input: CoreLibraryModuleAdapterInput,
): CoreLibraryModuleAdapter => {
  const readPageDetail = async (
    pageId: string,
  ): Promise<{
    readonly detail: CorePageDetail;
    readonly authorization: NonNullable<LibraryReadSnapshot["authorization"]>;
  }> => {
    const snapshot = await input.client.libraryRead({
      kind: "page_detail",
      page_id: pageId,
    });
    if (snapshot.value.kind !== "page_detail") {
      throw new Error("Core returned a non-Page-detail Library read value");
    }
    const detail = snapshot.value.value;
    if (detail.library_id !== input.libraryId || detail.store_epoch !== snapshot.store_epoch) {
      throw new Error("Core Page Detail escaped its Library snapshot boundary");
    }
    if (detail.commit_seq !== snapshot.commit_head) {
      throw new Error("Core Page Detail crossed its LocalCommit snapshot boundary");
    }
    if (!snapshot.authorization) {
      throw new Error("Core Page Detail omitted its authorization stamp");
    }
    return { detail, authorization: snapshot.authorization };
  };

  type CoreBlockPropertyApplyRequest = {
    readonly mutationId: string;
    readonly storeEpoch: string;
    readonly clientSessionId?: string;
    readonly actor: BlockPropertyMutationRequestV2["actor"];
    readonly fields: BlockPropertyMutationRequestV2["fields"];
  };
  type CoreBlockPropertyApplyResult =
    | {
        readonly ok: true;
        readonly localCommit: LocalCommitApply;
        readonly value: Omit<BlockPropertyMutationResultV2, "projectId">;
      }
    | Extract<BlockPropertyMutationCommandResultV2, { readonly ok: false }>;

  const applyCoreBlockProperty = async (
    request: CoreBlockPropertyApplyRequest,
  ): Promise<CoreBlockPropertyApplyResult> => {
    if (request.storeEpoch !== input.storeEpoch) {
      return {
        ok: false,
        error: {
          code: "store_epoch_mismatch",
          message: "Property mutation targets a stale Store epoch",
          retryable: false,
          mutationId: request.mutationId,
        },
      };
    }
    try {
      const committed = await input.client.libraryApply({
        operationId: request.mutationId,
        intent: {
          kind: "apply_block_property_mutation",
          mutation: toCoreBlockPropertyMutation(
            request.fields,
            request.actor,
            request.clientSessionId,
          ),
        },
      });
      const receipt = committed.outcome.block_property_mutation;
      const storeEpoch = applyResultStoreEpoch(committed);
      if (
        !receipt ||
        storeEpoch !== request.storeEpoch ||
        committed.receipt.operation_id !== request.mutationId ||
        committed.receipt.operation_kind !== "property_batch"
      ) {
        throw new Error("Core Property mutation receipt escaped its operation boundary");
      }
      const rejected = fromCoreBlockPropertyOutcome(request.mutationId, receipt.outcome);
      if (rejected) return rejected;
      if (receipt.outcome.status !== "committed") {
        throw new Error("Core returned an invalid Property mutation outcome");
      }
      return {
        ok: true,
        localCommit: rendererLocalCommitApply(committed),
        value: {
          mutationId: request.mutationId,
          storeEpoch,
          duplicate: committed.receipt.duplicate,
          fields: receipt.outcome.fields.map(fromCoreBlockPropertyField),
          blockMetadataRevisions: receipt.outcome.block_metadata_revisions,
          commitSeq: applyResultCursor(committed),
          committedAt: committed.receipt.committed_at,
        },
      };
    } catch (error) {
      return blockPropertyFailure(request.mutationId, error);
    }
  };

  const applyBlockProperty = async (
    request: CoreBlockPropertyApplyRequest & { readonly projectId: string },
  ): Promise<BlockPropertyMutationCommandResultV2> => {
    const result = await applyCoreBlockProperty(request);
    if (!result.ok) return result;
    return parseBlockPropertyMutationCommandResultV2({
      ...result,
      value: { ...result.value, projectId: request.projectId },
    });
  };

  return {
    read: async (request) => {
      try {
        const snapshot = await input.client.libraryRead(toCoreRead(request));
        return {
          ok: true,
          value: {
            profileId: input.profileId,
            libraryId: input.libraryId,
            storeEpoch: snapshot.store_epoch,
            commitSeq: snapshot.commit_head,
            authorization: snapshot.authorization ?? null,
            value: mapReadValue(snapshot),
          },
        };
      } catch (error) {
        return failure(error);
      }
    },
    apply: async (request) => {
      if (request.storeEpoch !== input.storeEpoch) {
        return {
          ok: false,
          error: {
            code: "store_epoch_mismatch",
            message: "Library operation targets a stale Store epoch",
            retryable: false,
          },
        };
      }
      try {
        const committed = await input.client.libraryApply({
          operationId: request.operationId,
          intent: toCoreIntent(request.operation),
        });
        const receipt = committed.receipt;
        const storeEpoch = applyResultStoreEpoch(committed);
        return {
          ok: true,
          localCommit: rendererLocalCommitApply(committed),
          value: {
            operationId: receipt.operation_id,
            profileId: input.profileId,
            storeEpoch,
            libraryId: input.libraryId,
            operationKind: request.operation.kind,
            duplicate: receipt.duplicate,
            didMutate: receipt.did_mutate,
            createdTarget: receipt.created_target
              ? fromCoreCreatedTarget(receipt.created_target)
              : null,
            canvasMutation: committed.outcome.canvas_mutation
              ? {
                  operationKind: committed.outcome.canvas_mutation.operation_kind,
                  canvasId: committed.outcome.canvas_mutation.canvas_id,
                  documentId: committed.outcome.canvas_mutation.document_id,
                  sourceCanvasId: committed.outcome.canvas_mutation.source_canvas_id ?? null,
                  locationRevision: committed.outcome.canvas_mutation.location_revision,
                  metadataRevision: committed.outcome.canvas_mutation.metadata_revision,
                  documentCommits: committed.outcome.canvas_mutation.document_commits.map(
                    (commit) => ({
                      documentId: commit.document_id,
                      generation: commit.generation,
                      baseHeadSeq: commit.base_head_seq,
                      headSeq: commit.head_seq,
                      updateId: commit.update_id,
                      update: Uint8Array.from(commit.update),
                      stateVector: Uint8Array.from(commit.state_vector),
                    }),
                  ),
                }
              : null,
            structuralEdit: committed.outcome.structural_edit
              ? {
                  operationKind: committed.outcome.structural_edit.operation_kind,
                  sourceRootBlockIds: committed.outcome.structural_edit.source_root_block_ids,
                  resultRootBlockIds: committed.outcome.structural_edit.result_root_block_ids,
                  copiedBlockIds: committed.outcome.structural_edit.copied_block_ids,
                  copiedDocumentIds: committed.outcome.structural_edit.copied_document_ids,
                  documentCommits: committed.outcome.structural_edit.document_commits.map(
                    (commit) => ({
                      documentId: commit.document_id,
                      generation: commit.generation,
                      baseHeadSeq: commit.base_head_seq,
                      headSeq: commit.head_seq,
                      updateId: commit.update_id,
                      update: Uint8Array.from(commit.update),
                      stateVector: Uint8Array.from(commit.state_vector),
                    }),
                  ),
                  affectedPageIds: committed.outcome.structural_edit.affected_page_ids,
                  affectedDatabaseIds:
                    committed.outcome.structural_edit.affected_database_ids.map(parseDatabaseId),
                  fileOwnershipMoves: committed.outcome.structural_edit.file_ownership_moves.map(
                    (move) => ({
                      fileId: move.file_id,
                      previousOwnerPageId: move.previous_owner_page_id,
                      ownerPageId: move.owner_page_id,
                      previousLogicalPath: move.previous_logical_path,
                      logicalPath: move.logical_path,
                      version: move.version,
                    }),
                  ),
                  clipboard: committed.outcome.structural_edit.clipboard
                    ? {
                        bundleId: committed.outcome.structural_edit.clipboard.bundle_id,
                        capability: committed.outcome.structural_edit.clipboard.capability,
                        manifestHash: committed.outcome.structural_edit.clipboard.manifest_hash,
                        storeEpoch: committed.outcome.structural_edit.clipboard.store_epoch,
                      }
                    : null,
                  history: committed.outcome.structural_edit.history
                    ? {
                        recipeOperationId:
                          committed.outcome.structural_edit.history.recipe_operation_id,
                        recipeHash: committed.outcome.structural_edit.history.recipe_hash,
                        storeEpoch: committed.outcome.structural_edit.history.store_epoch,
                      }
                    : null,
                  supersededHistoryRecipeOperationIds:
                    committed.outcome.structural_edit.superseded_history_recipe_operation_ids,
                  resume: committed.outcome.structural_edit.resume
                    ? {
                        blockId: committed.outcome.structural_edit.resume.block_id,
                        edge: committed.outcome.structural_edit.resume.edge,
                        fallbackBeforeBlockId:
                          committed.outcome.structural_edit.resume.fallback_before_block_id ?? null,
                        fallbackAfterBlockId:
                          committed.outcome.structural_edit.resume.fallback_after_block_id ?? null,
                      }
                    : null,
                }
              : null,
            pageFiles: committed.outcome.page_files
              ? {
                  pageId: committed.outcome.page_files.page_id,
                  manifestRevision: committed.outcome.page_files.manifest_revision,
                  createdFileIds: committed.outcome.page_files.created_file_ids,
                  updatedFileIds: committed.outcome.page_files.updated_file_ids,
                  deletedFileIds: committed.outcome.page_files.deleted_file_ids,
                  consumedBlobReceiptIds: committed.outcome.page_files.consumed_blob_receipt_ids,
                }
              : null,
            affectedParentKeys: receipt.affected_parent_keys,
            affectedPageIds: receipt.affected_page_ids,
            affectedDatabaseIds: receipt.affected_database_ids.map(parseDatabaseId),
            affectedViewIds: receipt.affected_view_ids.map(parseDatabaseViewId),
            committedRevisions: receipt.committed_revisions,
            commitSeq: applyResultCursor(committed),
            committedAt: receipt.committed_at,
          },
        };
      } catch (error) {
        return failure(error);
      }
    },
    readProjectPageDetail: async (projectId, pageId) => {
      try {
        const snapshot = await readPageDetail(pageId);
        return parsePageDetailResult({
          ok: true,
          value: {
            ...mapPageDetail(snapshot.detail, snapshot.authorization),
            projectId,
          },
        });
      } catch (error) {
        return { ok: false, error: pageDetailError(error) };
      }
    },
    readLibraryPageDetail: async (pageId) => {
      try {
        const snapshot = await readPageDetail(pageId);
        return parseLibraryPageDetailResult({
          ok: true,
          value: {
            ...mapPageDetail(snapshot.detail, snapshot.authorization),
            accessContext: { kind: "library" },
          },
        });
      } catch (error) {
        return { ok: false, error: pageDetailError(error) };
      }
    },
    listPageHistory: async (request) => {
      try {
        const snapshot = await input.client.libraryRead({
          kind: "page_history",
          page_id: request.pageId,
          before: request.before
            ? request.before.source === "document_version"
              ? {
                  occurred_at: request.before.occurredAt,
                  source: request.before.source,
                  version_id: request.before.versionId,
                }
              : {
                  occurred_at: request.before.occurredAt,
                  source: request.before.source,
                  change_seq: request.before.changeSeq,
                }
            : null,
          limit: request.pageSize ?? null,
        });
        if (snapshot.value.kind !== "page_history") {
          throw new Error("Core returned a non-Page-history Library read value");
        }
        const page = snapshot.value.value;
        if (page.library_id !== input.libraryId || page.page_id !== request.pageId) {
          throw new Error("Core Page history escaped its Library Page scope");
        }
        return parsePageHistoryCommandResult({
          ok: true,
          value: mapPageHistory(page),
        });
      } catch (error) {
        return { ok: false, error: pageHistoryError(error) };
      }
    },
    searchPages: async (searchInput, signal) => {
      const snapshot = await input.client.libraryRead(
        {
          kind: "project_page_search",
          project_ids: searchInput.projectIds,
          query: searchInput.query,
          filters: searchInput.filters
            ? {
                statuses: searchInput.filters.statuses ?? null,
                priorities: searchInput.filters.priorities ?? null,
                include_empty_priority: searchInput.filters.includeEmptyPriority,
                tags: searchInput.filters.tags.map((tag) => ({
                  data_source_id: tag.dataSourceId,
                  property_id: tag.propertyId,
                  option_id: tag.optionId,
                })),
                tag_mode: searchInput.filters.tagMode,
                assignees: searchInput.filters.assignees,
              }
            : null,
          preferred_project_id: searchInput.preferredProjectId ?? null,
          recent_page_ids: searchInput.recentPageIds ?? [],
          limit: searchInput.limit ?? null,
        },
        { signal },
      );
      if (
        snapshot.store_epoch !== input.storeEpoch ||
        snapshot.value.kind !== "project_page_search"
      ) {
        throw new Error("Core Project Page search escaped its snapshot boundary");
      }
      const results = snapshot.value.items.map((item): PageSearchResult => {
        if (
          !item.project_id ||
          !item.page_id ||
          typeof item.title !== "string" ||
          (item.page_key !== null && typeof item.page_key !== "string") ||
          (item.status != null && !isWorkflowStatus(item.status)) ||
          (item.priority != null && !isPriority(item.priority)) ||
          typeof item.location_label !== "string" ||
          typeof item.updated_at !== "string"
        ) {
          throw new Error("Core Project Page search returned invalid evidence");
        }
        return {
          projectId: item.project_id,
          pageId: item.page_id,
          pageKey: item.page_key ?? null,
          title: item.title,
          status: item.status ?? null,
          priority: item.priority ?? null,
          tags: item.tags.map(mapPageSearchOption),
          assignee: item.assignee ?? null,
          locationLabel: item.location_label,
          titleParts: mapPageSearchParts(item.title_parts),
          excerpt: item.excerpt ?? null,
          excerptParts: mapPageSearchParts(item.excerpt_parts),
          matches: item.matches.map(mapPageSearchMatch),
          updatedAt: item.updated_at,
        };
      });
      return {
        libraryId: input.libraryId,
        storeEpoch: snapshot.store_epoch,
        commitSeq: snapshot.commit_head,
        results,
      };
    },
    pageSearchMetadata: async (projectIds, pageIds) => {
      const snapshot = await input.client.libraryRead({
        kind: "project_page_search_metadata",
        project_ids: projectIds,
        page_ids: pageIds ?? null,
      });
      if (
        snapshot.store_epoch !== input.storeEpoch ||
        snapshot.value.kind !== "project_page_search_metadata"
      ) {
        throw new Error("Core Page search metadata escaped its snapshot boundary");
      }
      const value: CoreProjectPageSearchMetadataValue = snapshot.value;
      return {
        libraryId: input.libraryId,
        storeEpoch: snapshot.store_epoch,
        commitSeq: snapshot.commit_head,
        authorization: {
          libraryId: input.libraryId,
          storeEpoch: snapshot.store_epoch,
          coveredCommitSeq: snapshot.commit_head,
          projectIds: [...projectIds],
        },
        documents: value.items.map((item) => {
          validatePageSearchMetadataItem(item);
          return {
            pageId: item.page_id,
            pageKey: item.page_key ?? null,
            title: item.title,
            preview: item.preview,
            status: item.status ?? null,
            priority: item.priority !== null && isPriority(item.priority) ? item.priority : null,
            tags: item.tags.map(mapPageSearchOption),
            assignee: item.assignee ?? null,
            locationLabel: item.location_label,
            updatedAt: item.updated_at,
            properties: item.properties.map((property) => ({
              propertyId: property.property_id,
              propertyName: property.property_name,
              text: property.text,
            })),
            authorizedProjectIds: [...item.authorized_project_ids],
            dataSourceIds: [...item.data_source_ids],
          };
        }),
      };
    },
    pageSearchFacets: async (projectIds) => {
      const snapshot = await input.client.libraryRead({
        kind: "project_page_search_facets",
        project_ids: projectIds,
      });
      if (
        snapshot.store_epoch !== input.storeEpoch ||
        snapshot.value.kind !== "project_page_search_facets"
      ) {
        throw new Error("Core Page search facets escaped its snapshot boundary");
      }
      return {
        tags: snapshot.value.value.tags.map(mapPageSearchOption),
        assignees: [...snapshot.value.value.assignees],
      };
    },
    resolvePageTarget: async (request) => {
      const snapshot = await input.client.libraryRead({
        kind: "page_target",
        page_id: request.targetPageId,
      });
      if (snapshot.value.kind !== "page_target") {
        throw new Error("Core returned a non-Page-target Library read value");
      }
      const value = snapshot.value.value;
      if (!value) return null;
      if (value.target_page_id !== request.targetPageId) {
        throw new Error("Core Page target escaped its requested identity");
      }
      return mapPageTarget(value, {
        libraryId: input.libraryId,
        storeEpoch: snapshot.store_epoch,
        commitSeq: snapshot.commit_head,
        authorization: snapshot.authorization ?? null,
      });
    },
    resolvePageOwnershipPath: async (request) => {
      const snapshot = await input.client.libraryRead({
        kind: "page_ownership_path",
        page_id: request.targetPageId,
      });
      if (snapshot.value.kind !== "page_ownership_path") {
        throw new Error("Core returned a non-ownership-path Library read value");
      }
      const value = snapshot.value.value;
      if (!value) return null;
      if (value.target_page_id !== request.targetPageId) {
        throw new Error("Core Page ownership path escaped its requested identity");
      }
      return mapPageOwnershipPath(value, {
        libraryId: input.libraryId,
        storeEpoch: snapshot.store_epoch,
        commitSeq: snapshot.commit_head,
        authorization: snapshot.authorization ?? null,
      });
    },
    findPageLocation: async (pageId) => {
      const snapshot = await input.client.libraryRead({
        kind: "page_location",
        page_id: pageId,
      });
      if (snapshot.value.kind !== "page_location") {
        throw new Error("Core returned a non-Page-location Library read value");
      }
      const value = snapshot.value.value;
      if (!value) return null;
      if (value.page_id !== pageId || !value.access_project_id) {
        throw new Error("Core Page location escaped its requested identity");
      }
      return { pageId: value.page_id, projectId: value.access_project_id };
    },
    findViewLocation: async (viewId) => {
      const snapshot = await input.client.libraryRead({
        kind: "view_location",
        view_id: viewId,
      });
      if (snapshot.value.kind !== "view_location") {
        throw new Error("Core returned a non-View-location Library read value");
      }
      const value = snapshot.value.value;
      if (!value) return null;
      if (value.view_id !== viewId || !value.access_project_id) {
        throw new Error("Core View location escaped its requested identity");
      }
      return {
        viewId: value.view_id,
        dataSourceId: value.data_source_id,
        databaseId: value.database_id,
        projectId: value.access_project_id,
      };
    },
    readPageLifecyclePreflight: async (projectId, pageId) => {
      try {
        const snapshot = await input.client.libraryRead({
          kind: "page_lifecycle_preflight",
          page_id: pageId,
        });
        if (
          snapshot.value.kind !== "page_lifecycle_preflight" ||
          snapshot.store_epoch !== input.storeEpoch
        ) {
          throw new Error("Core Page lifecycle preflight escaped its snapshot boundary");
        }
        return parsePageLifecyclePreflightResultV2({
          ok: true,
          value: {
            projectId,
            libraryId: input.libraryId,
            storeEpoch: snapshot.store_epoch,
            commitSeq: snapshot.commit_head,
            value: mapPageLifecyclePreflight(snapshot.value.value),
          },
        });
      } catch (error) {
        return pageLifecyclePreflightFailure(error);
      }
    },
    applyPageLifecycleMutation: async (request) => {
      if (request.storeEpoch !== input.storeEpoch) {
        return parsePageLifecycleMutationCommandResultV2({
          ok: false,
          error: {
            code: "store_epoch_mismatch",
            message: "Page lifecycle operation targets a stale Store epoch",
            retryable: false,
            operationId: request.operationId,
            pageId: request.operation.pageId,
          },
        });
      }
      try {
        const committed = await input.client.libraryApply({
          operationId: request.operationId,
          intent: {
            kind: "apply_page_lifecycle",
            mutation: toCorePageLifecycleMutation(request.operation),
          },
        });
        const lifecycle = committed.outcome.page_lifecycle;
        const storeEpoch = applyResultStoreEpoch(committed);
        if (
          !lifecycle ||
          storeEpoch !== request.storeEpoch ||
          committed.receipt.operation_id !== request.operationId ||
          committed.receipt.operation_kind !== request.operation.kind ||
          lifecycle.operation_kind !== request.operation.kind ||
          lifecycle.page_id !== request.operation.pageId
        ) {
          throw new Error("Core Page lifecycle receipt escaped its operation boundary");
        }
        return parsePageLifecycleMutationCommandResultV2({
          ok: true,
          localCommit: rendererLocalCommitApply(committed),
          value: {
            operationKind: lifecycle.operation_kind,
            operationId: committed.receipt.operation_id,
            projectId: request.projectId,
            storeEpoch,
            pageId: lifecycle.page_id,
            duplicate: committed.receipt.duplicate,
            metadataRevision: lifecycle.metadata_revision,
            parentRevision: lifecycle.parent_revision,
            lifecycle: lifecycle.lifecycle,
            documentId: lifecycle.document_id,
            documentGeneration: lifecycle.document_generation,
            documentHeadSeq: lifecycle.document_head_seq,
            databaseId: lifecycle.database_id,
            dataSourceId: lifecycle.data_source_id,
            membershipId: lifecycle.membership_id,
            viewId: lifecycle.view_id,
            libraryRankKey: lifecycle.library_rank_key,
            viewRankKey: lifecycle.view_rank_key,
            createdBlockIds: lifecycle.created_block_ids,
            createdTagOptionIds: lifecycle.created_tag_option_ids,
            commitSeq: applyResultCursor(committed),
            committedAt: committed.receipt.committed_at,
          },
        });
      } catch (error) {
        return pageLifecycleMutationFailure(request, error);
      }
    },
    applyBlockPropertyMutation: async (request) => await applyBlockProperty(request),
    applyLibraryBlockPropertyMutation: async ({ request, actor }) => {
      const result = await applyCoreBlockProperty({
        ...request,
        actor,
      });
      if (!result.ok) return result;
      return parseLibraryBlockPropertyMutationCommandResultV2({
        ok: true,
        localCommit: result.localCommit,
        value: {
          mutationId: result.value.mutationId,
          accessContext: { kind: "library" },
          storeEpoch: result.value.storeEpoch,
          duplicate: result.value.duplicate,
          fields: result.value.fields,
          blockMetadataRevisions: result.value.blockMetadataRevisions,
          commitSeq: result.value.commitSeq,
          committedAt: result.value.committedAt,
        },
      });
    },
  };
};
