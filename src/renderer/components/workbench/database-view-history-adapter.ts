import { transferBlocks, applyLibraryModule } from "@/lib/api";
import { resolveBlockDocumentStructuralMutationParticipant } from "@/lib/block-document-mutation-registry";
import {
  commitDatabaseViewOperations,
  DatabaseViewMutationError,
  type DatabaseViewMutationReceipt,
  type DatabaseViewMutationScope,
} from "@/lib/database-view-row-mutations";
import type { DatabaseViewRenderModel } from "@/lib/database-view-render-model";
import { readTaskShorthandPagePromotionEnabled } from "@/lib/page-promotion-preference";
import {
  abandonPromotion,
  abandonStructuralHistory,
  promotionRetentionResources,
  releaseStructuralHistory,
} from "@/lib/surface-history/structural-resources";
import type {
  HistoryContentAdapter,
  HistoryReceiptInterpretation,
} from "@/lib/surface-history/owner";
import type {
  BlockTransferCommandResult,
  BlockTransferDataSourcePlacement,
} from "../../../shared/block-transfer";
import type {
  LibraryModuleApplyResult,
  LibraryStructuralHistoryToken,
} from "../../../shared/library-module";
import type {
  DatabaseApplyOperationV2,
  DatabaseDataEditUndoRecipeV2,
  DatabaseListMoveUndoRecipeV2,
} from "../../../shared/database-module-v2";
import { createUuidV7 } from "../../../shared/uuid-v7";
import {
  buildBlockToDataSourceTransferIntent,
  containsCanvasBlockDrag,
  containsDatabaseBlockDrag,
  resolvePagePromotionPolicy,
  type LocalBlockDragSession,
} from "./block-transfer/cross-surface-drag";

export interface DatabaseViewOperationsCommand {
  readonly model: Pick<
    DatabaseViewRenderModel,
    "libraryId" | "accessContext" | "storeEpoch" | "databaseViewId" | "readOnlyReason" | "viewName"
  >;
  readonly operations: readonly DatabaseApplyOperationV2[];
  readonly label?: string;
  readonly commitOperations?: typeof commitDatabaseViewOperations;
  readonly submitForward?: typeof commitDatabaseViewOperations;
}

export interface DatabaseViewBlockDropCommand {
  readonly historyScopeKey: string;
  readonly session: LocalBlockDragSession;
  readonly projectId: string;
  readonly storeEpoch: string;
  readonly dataSourceId: string;
  readonly placement: BlockTransferDataSourcePlacement;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

export type DatabaseViewHistoryIntent =
  | { readonly kind: "data"; readonly command: DatabaseViewOperationsCommand }
  | { readonly kind: "block_drop"; readonly command: DatabaseViewBlockDropCommand };

type DatabaseViewHistoryRequest =
  | {
      readonly kind: "data";
      readonly scope: DatabaseViewMutationScope;
      readonly operations: readonly DatabaseApplyOperationV2[];
      readonly operationId: string;
      readonly replay: boolean;
    }
  | { readonly kind: "transfer"; readonly request: Parameters<typeof transferBlocks>[1] }
  | {
      readonly kind: "reverse_transfer";
      readonly projectId: string;
      readonly request: Parameters<typeof applyLibraryModule>[1];
    };

export type DatabaseViewHistoryReceipt =
  | {
      readonly kind: "data";
      readonly scope: DatabaseViewMutationScope;
      readonly receipt: DatabaseViewMutationReceipt | null;
    }
  | {
      readonly kind: "transfer";
      readonly result: Extract<BlockTransferCommandResult, { readonly ok: true }>;
    }
  | {
      readonly kind: "reverse_transfer";
      readonly projectId: string;
      readonly result: Extract<LibraryModuleApplyResult, { readonly ok: true }>;
    };

type DatabaseViewHistoryInverse =
  | {
      readonly kind: "data_edit";
      readonly scope: DatabaseViewMutationScope;
      readonly recipe: DatabaseDataEditUndoRecipeV2;
    }
  | {
      readonly kind: "list_move";
      readonly scope: DatabaseViewMutationScope;
      readonly recipe: DatabaseListMoveUndoRecipeV2;
    }
  | {
      readonly kind: "block_transfer";
      readonly projectId: string;
      readonly token: LibraryStructuralHistoryToken;
    };

const dataLabel = (command: DatabaseViewOperationsCommand): string => {
  if (command.label) return command.label;
  const { operations, model } = command;
  if (operations.some((operation) => operation.kind === "move_list_occurrences"))
    return "Move Pages";
  if (
    operations.some(
      (operation) => operation.kind === "position_page" || operation.kind === "position_pages",
    )
  )
    return "Move Pages";
  if (operations.every((operation) => operation.kind === "edit_property_values"))
    return "Change Properties";
  return `Edit ${model.viewName}`;
};

/** Receipt coverage is all-or-nothing: a partial recipe cannot undo a whole gesture. */
export const interpretDatabaseViewHistoryReceipt = (
  value: DatabaseViewHistoryReceipt,
): HistoryReceiptInterpretation<DatabaseViewHistoryInverse> => {
  if (value.kind === "transfer") {
    const { history, projectId } = value.result.value;
    return history
      ? { kind: "reversible", inverse: { kind: "block_transfer", projectId, token: history } }
      : { kind: "barrier", reason: "This transfer has no complete inverse." };
  }
  if (value.kind === "reverse_transfer") {
    const token = value.result.value.structuralEdit?.history;
    if (!token) return { kind: "barrier", reason: "This transfer has no complete inverse." };
    return {
      kind: "reversible",
      inverse: { kind: "block_transfer", projectId: value.projectId, token },
    };
  }
  const { receipt, scope } = value;
  if (!receipt) return { kind: "noop" };
  const outcome = receipt.operationOutcomes[0];
  if (
    receipt.operationOutcomes.length === 1 &&
    outcome?.kind === "data_edit" &&
    outcome.operationIndex === 0 &&
    outcome.operationCount === receipt.operationKinds.length &&
    receipt.operationKinds.every((kind) =>
      ["edit_property_values", "position_page", "position_pages", "reverse_data_edit"].includes(
        kind,
      ),
    )
  )
    return outcome.undoRecipe
      ? { kind: "reversible", inverse: { kind: "data_edit", scope, recipe: outcome.undoRecipe } }
      : { kind: "noop" };
  if (
    receipt.operationKinds.length === 1 &&
    ((receipt.operationKinds[0] === "move_list_occurrences" &&
      outcome?.kind === "list_occurrence_move") ||
      (receipt.operationKinds[0] === "undo_list_occurrence_move" &&
        outcome?.kind === "list_occurrence_move_undo")) &&
    receipt.operationOutcomes.length === 1 &&
    outcome.operationIndex === 0
  )
    return {
      kind: "reversible",
      inverse: { kind: "list_move", scope, recipe: outcome.undoRecipe },
    };
  return {
    kind: "barrier",
    reason: "The latest Database edit cannot be reversed. Earlier history has not been executed.",
  };
};

const prepareBlockDrop = async (
  command: DatabaseViewBlockDropCommand,
): Promise<DatabaseViewHistoryRequest> => {
  const { payload } = command.session;
  if (payload.projectId !== command.projectId || payload.storeEpoch !== command.storeEpoch)
    throw new Error("Block transfer belongs to another Project or store generation.");
  if (containsCanvasBlockDrag(payload))
    throw new Error("Canvas can only move between Page Documents, not into a Database View.");
  if (containsDatabaseBlockDrag(payload))
    throw new Error("Database blocks can only move through a typed Database action.");
  const participant = resolveBlockDocumentStructuralMutationParticipant(payload.sourceSurfaceId);
  if (!participant) throw new Error("The dragged Page editor changed; start the drag again.");
  const head = await participant.prepareAndFence();
  if (head.storeEpoch !== command.storeEpoch)
    throw new Error("The dragged Document belongs to another store generation.");
  return {
    kind: "transfer",
    request: buildBlockToDataSourceTransferIntent({
      operationId: createUuidV7(),
      projectId: command.projectId,
      storeEpoch: command.storeEpoch,
      payload,
      dataSourceId: command.dataSourceId,
      placement: command.placement,
      altKey: command.altKey,
      promotionPolicy: resolvePagePromotionPolicy({
        preferenceEnabled: readTaskShorthandPagePromotionEnabled(),
        shiftKey: command.shiftKey,
      }),
      causalDependencies: [
        {
          documentId: head.documentId,
          generation: head.generation,
          expectedHeadSeq: head.expectedHeadSeq,
        },
      ],
    }),
  };
};

/** A command captures its typed transport Adapter once, including optimistic Board delivery. */
export const databaseViewHistoryAdapter = (
  intent: DatabaseViewHistoryIntent,
): HistoryContentAdapter<
  DatabaseViewHistoryIntent,
  DatabaseViewHistoryRequest,
  DatabaseViewHistoryReceipt,
  DatabaseViewHistoryInverse
> => {
  const commit =
    intent.kind === "data"
      ? (intent.command.commitOperations ?? commitDatabaseViewOperations)
      : commitDatabaseViewOperations;
  return {
    describe: (action) =>
      action.kind === "data"
        ? dataLabel(action.command)
        : action.command.altKey
          ? "Copy to Database"
          : "Move to Database",
    prepare: async (action) => {
      if (action.kind === "block_drop")
        return { kind: "submit", request: await prepareBlockDrop(action.command) };
      const { model, operations } = action.command;
      if (model.readOnlyReason) throw new Error(model.readOnlyReason);
      return {
        kind: "submit",
        request: {
          kind: "data",
          scope: { accessContext: model.accessContext, storeEpoch: model.storeEpoch },
          operations,
          operationId: createUuidV7(),
          replay: false,
        },
      };
    },
    prepareInverse: async (inverse) => {
      if (inverse.kind === "block_transfer")
        return {
          kind: "submit",
          request: {
            kind: "reverse_transfer",
            projectId: inverse.projectId,
            request: {
              operationId: createUuidV7(),
              storeEpoch: inverse.token.storeEpoch,
              operation: { kind: "reverse_structural_edit", token: inverse.token },
            },
          },
        };
      return {
        kind: "submit",
        request: {
          kind: "data",
          scope: inverse.scope,
          operationId: createUuidV7(),
          replay: true,
          operations: [
            inverse.kind === "data_edit"
              ? { kind: "reverse_data_edit", recipe: inverse.recipe }
              : { kind: "undo_list_occurrence_move", recipe: inverse.recipe },
          ],
        },
      };
    },
    submit: async (request) => {
      if (request.kind === "data") {
        try {
          const submit =
            !request.replay && intent.kind === "data"
              ? (intent.command.submitForward ?? commit)
              : commit;
          const receipt = await submit({
            model: request.scope,
            operations: request.operations,
            operationId: request.operationId,
          });
          return { kind: "committed", receipt: { kind: "data", scope: request.scope, receipt } };
        } catch (error) {
          if (
            !(error instanceof DatabaseViewMutationError) ||
            error.commandError.code === "unknown"
          )
            throw error;
          return {
            kind: error.commandError.code === "recovery_required" ? "unrecoverable" : "rejected",
            reason: error.message,
            retryable: error.commandError.retryable,
          };
        }
      }
      if (request.kind === "transfer") {
        const result = await transferBlocks(request.request.projectId, request.request);
        if (result.ok) return { kind: "committed", receipt: { kind: "transfer", result } };
        return result.error.code === "unknown"
          ? { kind: "unknown", reason: result.error.message }
          : result.error.code === "recovery_required"
            ? { kind: "unrecoverable", reason: result.error.message }
            : { kind: "rejected", reason: result.error.message, retryable: result.error.retryable };
      }
      const result = await applyLibraryModule(
        { kind: "project", projectId: request.projectId },
        request.request,
      );
      if (result.ok)
        return {
          kind: "committed",
          receipt: { kind: "reverse_transfer", projectId: request.projectId, result },
        };
      return result.error.code === "unknown"
        ? { kind: "unknown", reason: result.error.message }
        : result.error.code === "recovery_required"
          ? { kind: "unrecoverable", reason: result.error.message }
          : {
              kind: "rejected",
              reason: result.error.message,
              retryable: result.error.retryable || result.error.code === "revision_conflict",
            };
    },
    interpret: interpretDatabaseViewHistoryReceipt,
    release: (inverse, reason) => {
      if (inverse.kind !== "block_transfer" || reason !== "discarded") return;
      return releaseStructuralHistory(
        { kind: "project", projectId: inverse.projectId },
        inverse.token.storeEpoch,
        [inverse.token],
      );
    },
    discardReceipt: (receipt) => {
      if (receipt.kind === "transfer") {
        const { value } = receipt.result;
        return releaseStructuralHistory(
          { kind: "project", projectId: value.projectId },
          value.storeEpoch,
          promotionRetentionResources(value),
        );
      }
    },
    abandon: async (request) => {
      if (request.kind === "transfer") return abandonPromotion(request.request);
      if (request.kind === "reverse_transfer")
        await abandonStructuralHistory(
          { kind: "project", projectId: request.projectId },
          request.request,
        );
    },
  };
};
