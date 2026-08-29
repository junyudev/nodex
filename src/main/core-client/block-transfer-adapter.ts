import {
  parseBlockTransferIntent,
  parseBlockTransferUndoIntent,
  type BlockTransferCommandError,
  type BlockTransferCommandResult,
  type BlockTransferIntent,
  type BlockTransferReceipt,
  type BlockTransferTransformationEvidence,
  type BlockTransferUndoCommandResult,
  type BlockTransferUndoIntent,
  type BlockTransferUndoReceipt,
} from "../../shared/block-transfer";
import { blockTransferFailure } from "../../shared/block-transfer-transport";
import type { BlockLocation } from "../../shared/block-documents/contracts";
import { CoreModuleResponseError } from "./core-client";
import { applyResultCursor, rendererLocalCommitApply } from "./types";
import { toCoreDatabaseViewPreferencesOverride } from "./database-presentation-adapter";
import type { CoreClientPort, LibraryIntent, LibraryApplyResult } from "./types";

export interface CoreBlockTransferAdapterInput {
  readonly client: CoreClientPort;
  readonly libraryId: string;
  readonly projectId: string;
  readonly storeEpoch: string;
}

export interface CoreBlockTransferAdapter {
  commit(intent: BlockTransferIntent): Promise<BlockTransferCommandResult>;
  undo(intent: BlockTransferUndoIntent): Promise<BlockTransferUndoCommandResult>;
}

type CoreTransferResult = NonNullable<LibraryApplyResult["outcome"]["block_transfer"]>;
type CoreTransferIntent = Extract<LibraryIntent, { kind: "transfer_blocks" }>["intent"];
type CoreUndoTransferResult = NonNullable<LibraryApplyResult["outcome"]["block_transfer_undo"]>;

const fromCoreFileOwnershipMove = (move: CoreTransferResult["file_ownership_moves"][number]) => ({
  fileId: move.file_id,
  previousOwnerPageId: move.previous_owner_page_id,
  ownerPageId: move.owner_page_id,
  previousLogicalPath: move.previous_logical_path,
  logicalPath: move.logical_path,
  version: move.version,
});
const toCoreIntent = (intent: BlockTransferIntent): CoreTransferIntent => ({
  actor: intent.actor,
  mode: intent.mode,
  root_block_ids: intent.rootBlockIds,
  causal_dependencies: (intent.causalDependencies ?? []).map((dependency) => ({
    document_id: dependency.documentId,
    generation: dependency.generation,
    expected_head_seq: dependency.expectedHeadSeq,
  })),
  source: (() => {
    switch (intent.source.kind) {
      case "library":
        return { kind: "library" as const, library_id: intent.source.libraryId };
      case "page":
        return { kind: "page" as const, page_id: intent.source.pageId };
      case "document":
        return { kind: "document" as const, document_id: intent.source.documentId };
      case "data_source":
        return { kind: "data_source" as const, data_source_id: intent.source.dataSourceId };
    }
  })(),
  target: (() => {
    switch (intent.target.kind) {
      case "library":
        return {
          kind: "library" as const,
          library_id: intent.target.libraryId,
          before_block_id: intent.target.beforeBlockId ?? null,
        };
      case "page":
        return {
          kind: "page" as const,
          page_id: intent.target.pageId,
          parent_block_id: intent.target.parentBlockId ?? null,
          before_block_id: intent.target.beforeBlockId ?? null,
        };
      case "document":
        return {
          kind: "document" as const,
          document_id: intent.target.documentId,
          parent_block_id: intent.target.parentBlockId ?? null,
          before_block_id: intent.target.beforeBlockId ?? null,
        };
      case "data_source":
        return {
          kind: "data_source" as const,
          data_source_id: intent.target.dataSourceId,
          placement:
            intent.target.placement.kind === "direct"
              ? {
                  kind: intent.target.placement.kind,
                  view_id: intent.target.placement.viewId,
                  preferences_override: toCoreDatabaseViewPreferencesOverride(
                    intent.target.placement.preferencesOverride,
                  ),
                  group_key: intent.target.placement.groupKey,
                  before_page_id: intent.target.placement.beforePageId ?? null,
                  sorted_property_values: (intent.target.placement.sortedPropertyValues ?? []).map(
                    (entry) => ({
                      property_id: entry.propertyId,
                      value: entry.value,
                    }),
                  ),
                }
              : {
                  kind: intent.target.placement.kind,
                  view_id: intent.target.placement.viewId,
                  preferences_override: toCoreDatabaseViewPreferencesOverride(
                    intent.target.placement.preferencesOverride,
                  ),
                  expected_projection: {
                    scope_key: intent.target.placement.expectedProjection.scopeKey,
                    schema_version: intent.target.placement.expectedProjection.schemaVersion,
                    revision: intent.target.placement.expectedProjection.revision,
                    covered_commit_seq: intent.target.placement.expectedProjection.coveredCommitSeq,
                    effect_hash: intent.target.placement.expectedProjection.effectHash,
                  },
                  target:
                    intent.target.placement.target.kind === "page"
                      ? {
                          kind: intent.target.placement.target.kind,
                          occurrence_key: intent.target.placement.target.occurrenceKey,
                          edge: intent.target.placement.target.edge,
                        }
                      : intent.target.placement.target.kind === "group"
                        ? {
                            kind: intent.target.placement.target.kind,
                            occurrence_key: intent.target.placement.target.occurrenceKey,
                          }
                        : { kind: intent.target.placement.target.kind },
                },
        };
    }
  })(),
  promotion_policy: intent.promotionPolicy,
});

const assertIntentScope = (
  input: CoreBlockTransferAdapterInput,
  intent: BlockTransferIntent,
): BlockTransferCommandError | null => {
  if (intent.projectId !== input.projectId) {
    return blockTransferFailure(
      "invalid_transfer_request",
      "Block transfer belongs to another Project",
      { operationId: intent.operationId },
    );
  }
  if (intent.storeEpoch !== input.storeEpoch) {
    return blockTransferFailure(
      "store_epoch_mismatch",
      "Block transfer belongs to another store epoch",
      { operationId: intent.operationId, reloadRequired: true },
    );
  }
  const referencedLibraryIds = [intent.source, intent.target]
    .filter((location) => location.kind === "library")
    .map((location) => location.libraryId);
  if (referencedLibraryIds.some((libraryId) => libraryId !== input.libraryId)) {
    return blockTransferFailure(
      "invalid_transfer_request",
      "Block transfer belongs to another Library",
      { operationId: intent.operationId },
    );
  }
  return null;
};

const fromCoreLocation = (
  location: CoreTransferResult["final_locations"][string],
): BlockLocation => {
  switch (location.kind) {
    case "library":
      return {
        kind: "library",
        libraryId: location.library_id,
        rankKey: location.rank_key,
      };
    case "document":
      return { kind: "document", documentId: location.document_id };
    case "data_source":
      return {
        kind: "data_source",
        databaseBlockId: location.database_id,
        dataSourceId: location.data_source_id,
      };
  }
};

const fromCoreTransformation = (
  evidence: CoreTransferResult["transformation_evidence"][number],
): BlockTransferTransformationEvidence => {
  if (evidence.kind !== "promote" && evidence.kind !== "wrap") {
    throw new Error("Core returned an unsupported Block transformation kind");
  }
  const promotion = (() => {
    if (
      evidence.promotion.kind === "not_requested" ||
      evidence.promotion.kind === "not_applicable" ||
      evidence.promotion.kind === "no_match"
    ) {
      return evidence.promotion;
    }
    if (evidence.promotion.grammar_version !== 1) {
      throw new Error(
        `Core returned unsupported task shorthand grammar v${evidence.promotion.grammar_version}`,
      );
    }
    const grammarVersion = 1 as const;
    if (evidence.promotion.kind === "preserved") {
      return {
        kind: "preserved" as const,
        grammarVersion,
        reason: evidence.promotion.reason,
      };
    }
    return {
      kind: "applied" as const,
      grammarVersion,
      priorityOptionId: evidence.promotion.priority_option_id,
      estimateOptionId: evidence.promotion.estimate_option_id ?? null,
      tagOptionIds: evidence.promotion.tag_option_ids,
      tagNames: evidence.promotion.tag_names,
      createdTagOptionIds: evidence.promotion.created_tag_option_ids,
    };
  })();
  return {
    sourceBlockId: evidence.sourceBlockId,
    resultPageId: evidence.resultPageId,
    kind: evidence.kind,
    sourceBlockType: evidence.sourceBlockType,
    semanticTitleHash: evidence.semanticTitleHash,
    consumedPropertyKeys: evidence.consumedPropertyKeys,
    ...(evidence.wrapperReason == null
      ? {}
      : {
          wrapperReason:
            evidence.wrapperReason as BlockTransferTransformationEvidence["wrapperReason"],
        }),
    bodyRootBlockIds: evidence.bodyRootBlockIds,
    sourceToResultBlockIds: evidence.sourceToResultBlockIds,
    promotion,
  };
};

const fromCoreResult = (
  intent: BlockTransferIntent,
  result: CoreTransferResult,
  duplicate: boolean,
  commitSeq: number,
  committedAt: string,
): BlockTransferReceipt => {
  return {
    operationId: intent.operationId,
    projectId: intent.projectId,
    storeEpoch: intent.storeEpoch,
    mode: result.mode,
    duplicate,
    sourceRootBlockIds: result.source_root_block_ids,
    resultRootBlockIds: result.result_root_block_ids,
    copiedBlockIds: result.copied_block_ids,
    transformationEvidence: result.transformation_evidence.map(fromCoreTransformation),
    finalLocations: Object.fromEntries(
      Object.entries(result.final_locations).map(([blockId, location]) => [
        blockId,
        fromCoreLocation(location),
      ]),
    ),
    finalLocationRevisions: result.final_location_revisions,
    documentCommits: result.document_commits.map((commit) => ({
      documentId: commit.document_id,
      generation: commit.generation,
      baseHeadSeq: commit.base_head_seq,
      headSeq: commit.head_seq,
      updateId: commit.update_id,
      update: Uint8Array.from(commit.update),
      stateVector: Uint8Array.from(commit.state_vector),
    })),
    affectedDatabaseBlockIds: result.affected_database_ids,
    fileOwnershipMoves: result.file_ownership_moves.map(fromCoreFileOwnershipMove),
    commitSeq,
    committedAt,
    undoToken: result.undo_token
      ? {
          transferOperationId: result.undo_token.transfer_operation_id,
          recipeHash: result.undo_token.recipe_hash,
          storeEpoch: result.undo_token.store_epoch,
        }
      : null,
  };
};

const fromCoreUndoResult = (
  intent: BlockTransferUndoIntent,
  result: CoreUndoTransferResult,
  duplicate: boolean,
  commitSeq: number,
  committedAt: string,
): BlockTransferUndoReceipt => ({
  operationId: intent.operationId,
  projectId: intent.projectId,
  storeEpoch: intent.storeEpoch,
  transferOperationId: result.transfer_operation_id,
  duplicate,
  restoredSourceRootIds: result.restored_source_root_ids,
  removedPageIds: result.removed_page_ids,
  documentCommits: result.document_commits.map((commit) => ({
    documentId: commit.document_id,
    generation: commit.generation,
    baseHeadSeq: commit.base_head_seq,
    headSeq: commit.head_seq,
    updateId: commit.update_id,
    update: Uint8Array.from(commit.update),
    stateVector: Uint8Array.from(commit.state_vector),
  })),
  fileOwnershipMoves: result.file_ownership_moves.map(fromCoreFileOwnershipMove),
  commitSeq,
  committedAt,
});

const coreFailure = (
  intent: Pick<BlockTransferIntent, "operationId"> & { readonly token?: unknown },
  error: unknown,
): BlockTransferCommandError => {
  if (!(error instanceof CoreModuleResponseError)) {
    return blockTransferFailure("unknown", error instanceof Error ? error.message : String(error), {
      operationId: intent.operationId,
      retryable: true,
    });
  }
  const options = {
    operationId: intent.operationId,
    retryable: error.coreError.retryable,
  };
  switch (error.coreError.code) {
    case "invalid_input":
      return blockTransferFailure(
        "unsupported_transfer",
        intent.token === undefined
          ? "These blocks can’t be transferred to that destination."
          : "This block move can’t be undone.",
        options,
      );
    case "unauthorized":
      return blockTransferFailure("invalid_transfer_request", error.message, options);
    case "not_found":
      return blockTransferFailure(
        intent.token === undefined ? "block_not_found" : "undo_unavailable",
        error.message,
        options,
      );
    case "stale_store_epoch":
      return blockTransferFailure("store_epoch_mismatch", error.message, {
        ...options,
        reloadRequired: true,
      });
    case "idempotency_key_reused":
      return blockTransferFailure("operation_id_collision", error.message, options);
    case "revision_conflict":
    case "head_conflict":
    case "generation_conflict":
      return blockTransferFailure(
        intent.token === undefined ? "source_head_mismatch" : "undo_conflict",
        error.message,
        {
          ...options,
          reloadRequired: intent.token === undefined,
        },
      );
    case "store_corrupt":
      return blockTransferFailure("recovery_required", error.message, {
        ...options,
        reloadRequired: true,
      });
    default:
      return blockTransferFailure("unknown", error.message, options);
  }
};

export const createCoreBlockTransferAdapter = (
  input: CoreBlockTransferAdapterInput,
): CoreBlockTransferAdapter => {
  return {
    commit: async (rawIntent) => {
      let intent: BlockTransferIntent;
      try {
        intent = parseBlockTransferIntent(rawIntent);
      } catch (error) {
        return { ok: false, error: coreFailure(rawIntent, error) };
      }
      const scopeError = assertIntentScope(input, intent);
      if (scopeError) return { ok: false, error: scopeError };
      try {
        const committed = await input.client.libraryApply({
          operationId: intent.operationId,
          intent: {
            kind: "transfer_blocks",
            intent: toCoreIntent(intent),
          },
        });
        const result = committed.outcome.block_transfer;
        if (!result || committed.receipt.operation_kind !== "transfer_blocks") {
          throw new Error("Core returned the wrong Library commit for Block transfer");
        }
        return {
          ok: true,
          localCommit: rendererLocalCommitApply(committed),
          value: fromCoreResult(
            intent,
            result,
            committed.receipt.duplicate,
            applyResultCursor(committed),
            committed.receipt.committed_at,
          ),
        };
      } catch (error) {
        return { ok: false, error: coreFailure(intent, error) };
      }
    },
    undo: async (rawIntent) => {
      let intent: BlockTransferUndoIntent;
      try {
        intent = parseBlockTransferUndoIntent(rawIntent);
      } catch (error) {
        return { ok: false, error: coreFailure(rawIntent, error) };
      }
      if (intent.projectId !== input.projectId || intent.storeEpoch !== input.storeEpoch) {
        return {
          ok: false,
          error: blockTransferFailure(
            intent.storeEpoch === input.storeEpoch
              ? "invalid_transfer_request"
              : "store_epoch_mismatch",
            "Block transfer Undo belongs to another Project or store epoch",
            { operationId: intent.operationId },
          ),
        };
      }
      try {
        const committed = await input.client.libraryApply({
          operationId: intent.operationId,
          intent: {
            kind: "undo_block_transfer",
            token: {
              transfer_operation_id: intent.token.transferOperationId,
              recipe_hash: intent.token.recipeHash,
              store_epoch: intent.token.storeEpoch,
            },
          },
        });
        const result = committed.outcome.block_transfer_undo;
        if (!result || committed.receipt.operation_kind !== "undo_block_transfer") {
          throw new Error("Core returned the wrong Library commit for Block transfer Undo");
        }
        return {
          ok: true,
          localCommit: rendererLocalCommitApply(committed),
          value: fromCoreUndoResult(
            intent,
            result,
            committed.receipt.duplicate,
            applyResultCursor(committed),
            committed.receipt.committed_at,
          ),
        };
      } catch (error) {
        return { ok: false, error: coreFailure(intent, error) };
      }
    },
  };
};
