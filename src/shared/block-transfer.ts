import type { DatabaseJsonValue } from "./database-kernel";
import { stableStringifyDatabaseJson } from "./database-kernel";
import type {
  BlockId,
  BlockLocation,
  DocumentId,
  DocumentCommitRef,
} from "./block-documents/contracts";
import type { LocalCommitCommandSuccess } from "./local-commit-delivery";
import type { BlockTransferUndoToken } from "./block-transfer-undo-token";
import {
  parseDatabaseViewPreferencesOverride,
  type DatabaseViewPreferencesOverride,
} from "./database-kernel";
import type {
  DatabaseListMoveTargetV2,
  DatabaseListProjectionExpectationV2,
} from "./database-module-v2";
import {
  parseDatabaseListMoveTargetV2,
  parseDatabaseListProjectionExpectationV2,
} from "./database-module-v2-transport";

export const MAX_BLOCK_TRANSFER_ROOTS = 10_000;
export const MAX_BLOCK_TRANSFER_ID_LENGTH = 512;

export type { BlockTransferUndoToken } from "./block-transfer-undo-token";

export type BlockTransferMode = "move" | "copy";
export type PagePromotionPolicy = "literal" | "task_shorthand_v1";

export type BlockTransferIntentSource =
  | { readonly kind: "library"; readonly libraryId: string }
  | { readonly kind: "page"; readonly pageId: BlockId }
  | { readonly kind: "document"; readonly documentId: DocumentId }
  | { readonly kind: "data_source"; readonly dataSourceId: string };

export type BlockTransferIntentTarget =
  | {
      readonly kind: "library";
      readonly libraryId: string;
      readonly beforeBlockId?: BlockId;
    }
  | {
      readonly kind: "page";
      readonly pageId: BlockId;
      readonly parentBlockId?: BlockId;
      readonly beforeBlockId?: BlockId;
    }
  | {
      readonly kind: "document";
      readonly documentId: DocumentId;
      readonly parentBlockId?: BlockId;
      readonly beforeBlockId?: BlockId;
    }
  | {
      readonly kind: "data_source";
      readonly dataSourceId: string;
      readonly placement: BlockTransferDataSourcePlacement;
    };

export type BlockTransferDataSourcePlacement =
  | {
      readonly kind: "direct";
      readonly viewId: string;
      readonly preferencesOverride: DatabaseViewPreferencesOverride;
      readonly groupKey: string | null;
      readonly beforePageId?: BlockId;
      readonly sortedPropertyValues?: readonly BlockTransferPropertyValue[];
    }
  | {
      readonly kind: "list_occurrence";
      readonly viewId: string;
      readonly preferencesOverride: DatabaseViewPreferencesOverride;
      readonly expectedProjection: DatabaseListProjectionExpectationV2;
      readonly target: DatabaseListMoveTargetV2;
    };

export interface BlockTransferPropertyValue {
  readonly propertyId: string;
  readonly value: DatabaseJsonValue;
}

/**
 * Public logical command. Freshness coordinates are deliberately absent:
 * only the SQLite writer may compile those from current authority.
 */
export interface BlockTransferIntent {
  readonly operationId: string;
  readonly projectId: string;
  readonly storeEpoch: string;
  readonly clientSessionId?: string;
  readonly actor: Readonly<Record<string, DatabaseJsonValue>>;
  readonly mode: BlockTransferMode;
  readonly rootBlockIds: readonly BlockId[];
  /** Durable document heads observed immediately before this mutation. */
  readonly causalDependencies: readonly BlockTransferDocumentHead[];
  readonly source: BlockTransferIntentSource;
  readonly target: BlockTransferIntentTarget;
  readonly promotionPolicy: PagePromotionPolicy;
}

export interface BlockTransferDocumentHead {
  readonly documentId: DocumentId;
  readonly generation: number;
  readonly expectedHeadSeq: number;
}

export interface BlockTransferPreparation {
  readonly request: BlockTransferRequest;
  readonly documentHeads: readonly BlockTransferDocumentHead[];
}

export type BlockTransferSource =
  | { readonly kind: "library"; readonly libraryId: string }
  | {
      readonly kind: "page";
      readonly pageId: BlockId;
      readonly documentId: DocumentId;
      readonly generation: number;
      readonly expectedHeadSeq: number;
    }
  | {
      readonly kind: "document";
      readonly documentId: DocumentId;
      readonly generation: number;
      readonly expectedHeadSeq: number;
    }
  | {
      readonly kind: "data_source";
      readonly dataSourceId: string;
      readonly memberships: Readonly<
        Record<BlockId, { readonly membershipId: string; readonly revision: number }>
      >;
    };

export type BlockTransferTarget =
  | {
      readonly kind: "library";
      readonly libraryId: string;
      readonly beforeBlockId?: BlockId;
    }
  | {
      readonly kind: "page";
      readonly pageId: BlockId;
      readonly documentId: DocumentId;
      readonly generation: number;
      readonly expectedHeadSeq: number;
      readonly parentBlockId?: BlockId;
      readonly beforeBlockId?: BlockId;
    }
  | {
      readonly kind: "document";
      readonly documentId: DocumentId;
      readonly generation: number;
      readonly expectedHeadSeq: number;
      readonly parentBlockId?: BlockId;
      readonly beforeBlockId?: BlockId;
    }
  | {
      readonly kind: "data_source";
      readonly dataSourceId: string;
      readonly viewId: string;
      readonly groupKey: string | null;
      readonly beforePageId?: BlockId;
    };

export interface BlockTransferRequest {
  readonly operationId: string;
  readonly projectId: string;
  readonly storeEpoch: string;
  readonly clientSessionId?: string;
  readonly actor: Readonly<Record<string, DatabaseJsonValue>>;
  readonly mode: BlockTransferMode;
  readonly rootBlockIds: readonly BlockId[];
  readonly expectedLocationRevisions: Readonly<Record<BlockId, number>>;
  readonly source: BlockTransferSource;
  readonly target: BlockTransferTarget;
}

export interface BlockTransferTransformationEvidence {
  readonly sourceBlockId: BlockId;
  readonly resultPageId: BlockId;
  readonly kind: "promote" | "wrap";
  readonly sourceBlockType: string;
  readonly semanticTitleHash: string;
  readonly consumedPropertyKeys: readonly string[];
  readonly wrapperReason?:
    | "type_requires_wrapper"
    | "unsupported_primary_content"
    | "unmapped_type_state";
  readonly bodyRootBlockIds: readonly BlockId[];
  readonly sourceToResultBlockIds: Readonly<Record<BlockId, BlockId>>;
  readonly promotion: BlockTransferPromotionEvidence;
}

export type TaskShorthandPreservedReason =
  | "malformed_shorthand"
  | "nonempty_title_required"
  | "rich_text_boundary"
  | "target_property_conflict"
  | "target_schema_incompatible"
  | "tag_schema_permission_required"
  | "tag_option_limit";

export type BlockTransferPromotionEvidence =
  | { readonly kind: "not_requested" }
  | { readonly kind: "not_applicable" }
  | { readonly kind: "no_match" }
  | {
      readonly kind: "applied";
      readonly grammarVersion: 1;
      readonly priorityOptionId: string;
      readonly estimateOptionId: string | null;
      readonly tagOptionIds: readonly string[];
      readonly tagNames: readonly string[];
      readonly createdTagOptionIds: readonly string[];
    }
  | {
      readonly kind: "preserved";
      readonly grammarVersion: 1;
      readonly reason: TaskShorthandPreservedReason;
    };

export interface BlockTransferReceipt {
  readonly operationId: string;
  readonly projectId: string;
  readonly storeEpoch: string;
  readonly mode: BlockTransferMode;
  readonly duplicate: boolean;
  readonly sourceRootBlockIds: readonly BlockId[];
  readonly resultRootBlockIds: readonly BlockId[];
  readonly copiedBlockIds: Readonly<Record<BlockId, BlockId>>;
  readonly transformationEvidence: readonly BlockTransferTransformationEvidence[];
  readonly finalLocations: Readonly<Record<BlockId, BlockLocation>>;
  readonly finalLocationRevisions: Readonly<Record<BlockId, number>>;
  readonly documentCommits: readonly DocumentCommitRef[];
  readonly affectedDatabaseBlockIds: readonly BlockId[];
  readonly commitSeq: number;
  readonly committedAt: string;
  readonly undoToken: BlockTransferUndoToken | null;
}

export interface BlockTransferUndoIntent {
  readonly operationId: string;
  readonly projectId: string;
  readonly storeEpoch: string;
  readonly token: BlockTransferUndoToken;
}

export interface BlockTransferUndoReceipt {
  readonly operationId: string;
  readonly projectId: string;
  readonly storeEpoch: string;
  readonly transferOperationId: string;
  readonly duplicate: boolean;
  readonly restoredSourceRootIds: readonly BlockId[];
  readonly removedPageIds: readonly BlockId[];
  readonly documentCommits: readonly DocumentCommitRef[];
  readonly commitSeq: number;
  readonly committedAt: string;
}

export type BlockTransferErrorCode =
  | "invalid_transfer_request"
  | "store_epoch_mismatch"
  | "operation_id_collision"
  | "project_not_found"
  | "block_not_found"
  | "block_not_active"
  | "source_parent_mismatch"
  | "location_revision_mismatch"
  | "source_head_mismatch"
  | "target_head_mismatch"
  | "membership_revision_mismatch"
  | "target_not_found"
  | "invalid_target"
  | "transfer_cycle"
  | "unsupported_transfer"
  | "undo_unavailable"
  | "undo_conflict"
  | "recovery_required"
  | "unknown";

export interface BlockTransferCommandError {
  readonly code: BlockTransferErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly reloadRequired: boolean;
  readonly operationId?: string;
}

export type BlockTransferCommandResult<Value = BlockTransferReceipt> =
  | LocalCommitCommandSuccess<Value>
  | { readonly ok: false; readonly error: BlockTransferCommandError };

export type BlockTransferUndoCommandResult = BlockTransferCommandResult<BlockTransferUndoReceipt>;

export class BlockTransferContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockTransferContractError";
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readRecord = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  if (isRecord(value)) return value;
  throw new BlockTransferContractError(`${label} must be an object`);
};

const assertExactKeys = (
  record: Readonly<Record<string, unknown>>,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void => {
  const requiredKeys = new Set(required);
  const allowedKeys = new Set([...required, ...optional]);
  for (const key of requiredKeys) {
    if (Object.hasOwn(record, key)) continue;
    throw new BlockTransferContractError(`${label}.${key} is required`);
  }
  for (const key of Object.keys(record)) {
    if (allowedKeys.has(key)) continue;
    throw new BlockTransferContractError(`${label}.${key} is not supported`);
  }
};

const readString = (
  record: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
  maximumLength = MAX_BLOCK_TRANSFER_ID_LENGTH,
): string => {
  const value = record[key];
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim()
  ) {
    return value;
  }
  throw new BlockTransferContractError(`${label}.${key} must be a non-empty bounded string`);
};

const readOptionalString = (
  record: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
): string | undefined => (record[key] === undefined ? undefined : readString(record, key, label));

const readInteger = (
  record: Readonly<Record<string, unknown>>,
  key: string,
  label: string,
  minimum: number,
): number => {
  const value = record[key];
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= minimum) {
    return value;
  }
  throw new BlockTransferContractError(`${label}.${key} must be a safe integer >= ${minimum}`);
};

const readRootBlockIds = (record: Readonly<Record<string, unknown>>): readonly BlockId[] => {
  const value = record.rootBlockIds;
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BLOCK_TRANSFER_ROOTS) {
    throw new BlockTransferContractError(
      `blockTransfer.rootBlockIds must contain 1-${MAX_BLOCK_TRANSFER_ROOTS} IDs`,
    );
  }
  const ids = value.map((entry) => {
    if (
      typeof entry === "string" &&
      entry.length > 0 &&
      entry.length <= MAX_BLOCK_TRANSFER_ID_LENGTH &&
      entry === entry.trim()
    ) {
      return entry;
    }
    throw new BlockTransferContractError("blockTransfer.rootBlockIds contains an invalid ID");
  });
  if (new Set(ids).size === ids.length) return ids;
  throw new BlockTransferContractError("blockTransfer.rootBlockIds contains a duplicate ID");
};

const readExpectedLocationRevisions = (
  record: Readonly<Record<string, unknown>>,
  rootBlockIds: readonly BlockId[],
): Readonly<Record<BlockId, number>> => {
  const revisions = readRecord(
    record.expectedLocationRevisions,
    "blockTransfer.expectedLocationRevisions",
  );
  const roots = new Set(rootBlockIds);
  if (
    Object.keys(revisions).length !== roots.size ||
    Object.keys(revisions).some((blockId) => !roots.has(blockId))
  ) {
    throw new BlockTransferContractError(
      "blockTransfer.expectedLocationRevisions must match rootBlockIds exactly",
    );
  }
  return Object.fromEntries(
    rootBlockIds.map((blockId) => {
      const revision = revisions[blockId];
      if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
        throw new BlockTransferContractError(
          `blockTransfer.expectedLocationRevisions.${blockId} must be a positive safe integer`,
        );
      }
      return [blockId, revision];
    }),
  );
};

const parseSource = (value: unknown, rootBlockIds: readonly BlockId[]): BlockTransferSource => {
  const source = readRecord(value, "blockTransfer.source");
  if (source.kind === "library") {
    assertExactKeys(source, "blockTransfer.source", ["kind", "libraryId"]);
    return {
      kind: "library",
      libraryId: readString(source, "libraryId", "blockTransfer.source"),
    };
  }
  if (source.kind === "page" || source.kind === "document") {
    const page = source.kind === "page";
    assertExactKeys(source, "blockTransfer.source", [
      "kind",
      ...(page ? ["pageId"] : []),
      "documentId",
      "generation",
      "expectedHeadSeq",
    ]);
    const revision = {
      documentId: readString(source, "documentId", "blockTransfer.source"),
      generation: readInteger(source, "generation", "blockTransfer.source", 1),
      expectedHeadSeq: readInteger(source, "expectedHeadSeq", "blockTransfer.source", 0),
    };
    return page
      ? {
          kind: "page",
          pageId: readString(source, "pageId", "blockTransfer.source"),
          ...revision,
        }
      : { kind: "document", ...revision };
  }
  if (source.kind === "data_source") {
    assertExactKeys(source, "blockTransfer.source", ["kind", "dataSourceId", "memberships"]);
    const memberships = readRecord(source.memberships, "blockTransfer.source.memberships");
    if (
      Object.keys(memberships).length !== rootBlockIds.length ||
      Object.keys(memberships).some((blockId) => !rootBlockIds.includes(blockId))
    ) {
      throw new BlockTransferContractError(
        "blockTransfer.source.memberships must match rootBlockIds exactly",
      );
    }
    return {
      kind: "data_source",
      dataSourceId: readString(source, "dataSourceId", "blockTransfer.source"),
      memberships: Object.fromEntries(
        rootBlockIds.map((blockId) => {
          const membership = readRecord(
            memberships[blockId],
            `blockTransfer.source.memberships.${blockId}`,
          );
          assertExactKeys(membership, `blockTransfer.source.memberships.${blockId}`, [
            "membershipId",
            "revision",
          ]);
          return [
            blockId,
            {
              membershipId: readString(
                membership,
                "membershipId",
                `blockTransfer.source.memberships.${blockId}`,
              ),
              revision: readInteger(
                membership,
                "revision",
                `blockTransfer.source.memberships.${blockId}`,
                1,
              ),
            },
          ];
        }),
      ),
    };
  }
  throw new BlockTransferContractError(
    "blockTransfer.source.kind must be library, page, document, or data_source",
  );
};

const parseTarget = (value: unknown, rootBlockIds: readonly BlockId[]): BlockTransferTarget => {
  const target = readRecord(value, "blockTransfer.target");
  if (target.kind === "library") {
    assertExactKeys(target, "blockTransfer.target", ["kind", "libraryId"], ["beforeBlockId"]);
    const beforeBlockId = readOptionalString(target, "beforeBlockId", "blockTransfer.target");
    if (beforeBlockId && rootBlockIds.includes(beforeBlockId)) {
      throw new BlockTransferContractError(
        "blockTransfer.target.beforeBlockId cannot be a transferred root",
      );
    }
    return {
      kind: "library",
      libraryId: readString(target, "libraryId", "blockTransfer.target"),
      ...(beforeBlockId ? { beforeBlockId } : {}),
    };
  }
  if (target.kind === "page" || target.kind === "document") {
    const page = target.kind === "page";
    assertExactKeys(
      target,
      "blockTransfer.target",
      ["kind", ...(page ? ["pageId"] : []), "documentId", "generation", "expectedHeadSeq"],
      ["parentBlockId", "beforeBlockId"],
    );
    const parentBlockId = readOptionalString(target, "parentBlockId", "blockTransfer.target");
    const beforeBlockId = readOptionalString(target, "beforeBlockId", "blockTransfer.target");
    if (
      (parentBlockId && rootBlockIds.includes(parentBlockId)) ||
      (beforeBlockId && rootBlockIds.includes(beforeBlockId))
    ) {
      throw new BlockTransferContractError(
        "blockTransfer Document anchors cannot be transferred roots",
      );
    }
    const destination = {
      documentId: readString(target, "documentId", "blockTransfer.target"),
      generation: readInteger(target, "generation", "blockTransfer.target", 1),
      expectedHeadSeq: readInteger(target, "expectedHeadSeq", "blockTransfer.target", 0),
      ...(parentBlockId ? { parentBlockId } : {}),
      ...(beforeBlockId ? { beforeBlockId } : {}),
    };
    return page
      ? {
          kind: "page",
          pageId: readString(target, "pageId", "blockTransfer.target"),
          ...destination,
        }
      : { kind: "document", ...destination };
  }
  if (target.kind === "data_source") {
    assertExactKeys(
      target,
      "blockTransfer.target",
      ["kind", "dataSourceId", "viewId", "groupKey"],
      ["beforePageId"],
    );
    const groupKey = target.groupKey;
    if (groupKey !== null && typeof groupKey !== "string") {
      throw new BlockTransferContractError(
        "blockTransfer.target.groupKey must be a string or null",
      );
    }
    const beforePageId = readOptionalString(target, "beforePageId", "blockTransfer.target");
    if (beforePageId && rootBlockIds.includes(beforePageId)) {
      throw new BlockTransferContractError(
        "blockTransfer.target.beforePageId cannot be a transferred root",
      );
    }
    return {
      kind: "data_source",
      dataSourceId: readString(target, "dataSourceId", "blockTransfer.target"),
      viewId: readString(target, "viewId", "blockTransfer.target"),
      groupKey,
      ...(beforePageId ? { beforePageId } : {}),
    };
  }
  throw new BlockTransferContractError(
    "blockTransfer.target.kind must be library, page, document, or data_source",
  );
};

const readActor = (value: unknown): Readonly<Record<string, DatabaseJsonValue>> => {
  const actor = readRecord(value, "blockTransfer.actor");
  try {
    return JSON.parse(stableStringifyDatabaseJson(actor)) as Readonly<
      Record<string, DatabaseJsonValue>
    >;
  } catch (error) {
    throw new BlockTransferContractError(
      `blockTransfer.actor must be bounded JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const parseIntentSource = (value: unknown): BlockTransferIntentSource => {
  const source = readRecord(value, "blockTransferIntent.source");
  if (source.kind === "library") {
    assertExactKeys(source, "blockTransferIntent.source", ["kind", "libraryId"]);
    return {
      kind: "library",
      libraryId: readString(source, "libraryId", "blockTransferIntent.source"),
    };
  }
  if (source.kind === "page") {
    assertExactKeys(source, "blockTransferIntent.source", ["kind", "pageId"]);
    return {
      kind: "page",
      pageId: readString(source, "pageId", "blockTransferIntent.source"),
    };
  }
  if (source.kind === "document") {
    assertExactKeys(source, "blockTransferIntent.source", ["kind", "documentId"]);
    return {
      kind: "document",
      documentId: readString(source, "documentId", "blockTransferIntent.source"),
    };
  }
  if (source.kind === "data_source") {
    assertExactKeys(source, "blockTransferIntent.source", ["kind", "dataSourceId"]);
    return {
      kind: "data_source",
      dataSourceId: readString(source, "dataSourceId", "blockTransferIntent.source"),
    };
  }
  throw new BlockTransferContractError(
    "blockTransferIntent.source.kind must be library, page, document, or data_source",
  );
};

const parseIntentTarget = (
  value: unknown,
  rootBlockIds: readonly BlockId[],
): BlockTransferIntentTarget => {
  const target = readRecord(value, "blockTransferIntent.target");
  if (target.kind === "library") {
    assertExactKeys(target, "blockTransferIntent.target", ["kind", "libraryId"], ["beforeBlockId"]);
    const beforeBlockId = readOptionalString(target, "beforeBlockId", "blockTransferIntent.target");
    if (beforeBlockId && rootBlockIds.includes(beforeBlockId)) {
      throw new BlockTransferContractError(
        "blockTransferIntent.target.beforeBlockId cannot be a transferred root",
      );
    }
    return {
      kind: "library",
      libraryId: readString(target, "libraryId", "blockTransferIntent.target"),
      ...(beforeBlockId ? { beforeBlockId } : {}),
    };
  }
  if (target.kind === "page") {
    assertExactKeys(
      target,
      "blockTransferIntent.target",
      ["kind", "pageId"],
      ["parentBlockId", "beforeBlockId"],
    );
    const parentBlockId = readOptionalString(target, "parentBlockId", "blockTransferIntent.target");
    const beforeBlockId = readOptionalString(target, "beforeBlockId", "blockTransferIntent.target");
    if (
      (parentBlockId && rootBlockIds.includes(parentBlockId)) ||
      (beforeBlockId && rootBlockIds.includes(beforeBlockId))
    ) {
      throw new BlockTransferContractError(
        "blockTransferIntent Page anchors cannot be transferred roots",
      );
    }
    return {
      kind: "page",
      pageId: readString(target, "pageId", "blockTransferIntent.target"),
      ...(parentBlockId ? { parentBlockId } : {}),
      ...(beforeBlockId ? { beforeBlockId } : {}),
    };
  }
  if (target.kind === "document") {
    assertExactKeys(
      target,
      "blockTransferIntent.target",
      ["kind", "documentId"],
      ["parentBlockId", "beforeBlockId"],
    );
    const parentBlockId = readOptionalString(target, "parentBlockId", "blockTransferIntent.target");
    const beforeBlockId = readOptionalString(target, "beforeBlockId", "blockTransferIntent.target");
    if (
      (parentBlockId && rootBlockIds.includes(parentBlockId)) ||
      (beforeBlockId && rootBlockIds.includes(beforeBlockId))
    ) {
      throw new BlockTransferContractError(
        "blockTransferIntent Document anchors cannot be transferred roots",
      );
    }
    return {
      kind: "document",
      documentId: readString(target, "documentId", "blockTransferIntent.target"),
      ...(parentBlockId ? { parentBlockId } : {}),
      ...(beforeBlockId ? { beforeBlockId } : {}),
    };
  }
  if (target.kind === "data_source") {
    assertExactKeys(target, "blockTransferIntent.target", ["kind", "dataSourceId", "placement"]);
    const placement = readRecord(target.placement, "blockTransferIntent.target.placement");
    const parsedPlacement: BlockTransferDataSourcePlacement = (() => {
      if (placement.kind === "direct") {
        assertExactKeys(
          placement,
          "blockTransferIntent.target.placement",
          ["kind", "viewId", "preferencesOverride", "groupKey"],
          ["beforePageId", "sortedPropertyValues"],
        );
        const groupKey =
          placement.groupKey === null
            ? null
            : readString(placement, "groupKey", "blockTransferIntent.target.placement");
        const beforePageId = readOptionalString(
          placement,
          "beforePageId",
          "blockTransferIntent.target.placement",
        );
        if (beforePageId && rootBlockIds.includes(beforePageId)) {
          throw new BlockTransferContractError(
            "blockTransferIntent.target.placement.beforePageId cannot be a transferred root",
          );
        }
        const sortedPropertyValues = (() => {
          if (placement.sortedPropertyValues === undefined) return [];
          if (
            !Array.isArray(placement.sortedPropertyValues) ||
            placement.sortedPropertyValues.length > 8
          ) {
            throw new BlockTransferContractError(
              "blockTransferIntent.target.placement.sortedPropertyValues must contain at most 8 values",
            );
          }
          const seen = new Set<string>();
          return placement.sortedPropertyValues.map((rawValue, index) => {
            const entry = readRecord(
              rawValue,
              `blockTransferIntent.target.placement.sortedPropertyValues[${index}]`,
            );
            assertExactKeys(
              entry,
              `blockTransferIntent.target.placement.sortedPropertyValues[${index}]`,
              ["propertyId", "value"],
            );
            const propertyId = readString(
              entry,
              "propertyId",
              `blockTransferIntent.target.placement.sortedPropertyValues[${index}]`,
            );
            if (seen.has(propertyId)) {
              throw new BlockTransferContractError(
                "blockTransferIntent.target.placement.sortedPropertyValues cannot repeat a Property",
              );
            }
            seen.add(propertyId);
            let value: DatabaseJsonValue;
            try {
              value = JSON.parse(stableStringifyDatabaseJson(entry.value)) as DatabaseJsonValue;
            } catch (error) {
              throw new BlockTransferContractError(
                `blockTransferIntent.target.placement.sortedPropertyValues[${index}].value must be bounded JSON: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            return { propertyId, value };
          });
        })();
        return {
          kind: placement.kind,
          viewId: readString(placement, "viewId", "blockTransferIntent.target.placement"),
          preferencesOverride: parseDatabaseViewPreferencesOverride(placement.preferencesOverride),
          groupKey,
          ...(beforePageId ? { beforePageId } : {}),
          ...(sortedPropertyValues.length > 0 ? { sortedPropertyValues } : {}),
        };
      }
      if (placement.kind === "list_occurrence") {
        assertExactKeys(placement, "blockTransferIntent.target.placement", [
          "kind",
          "viewId",
          "preferencesOverride",
          "expectedProjection",
          "target",
        ]);
        return {
          kind: placement.kind,
          viewId: readString(placement, "viewId", "blockTransferIntent.target.placement"),
          preferencesOverride: parseDatabaseViewPreferencesOverride(placement.preferencesOverride),
          expectedProjection: parseDatabaseListProjectionExpectationV2(
            placement.expectedProjection,
            "blockTransferIntent.target.placement.expectedProjection",
          ),
          target: parseDatabaseListMoveTargetV2(
            placement.target,
            "blockTransferIntent.target.placement.target",
          ),
        };
      }
      throw new BlockTransferContractError(
        "blockTransferIntent.target.placement.kind must be direct or list_occurrence",
      );
    })();
    return {
      kind: "data_source",
      dataSourceId: readString(target, "dataSourceId", "blockTransferIntent.target"),
      placement: parsedPlacement,
    };
  }
  throw new BlockTransferContractError(
    "blockTransferIntent.target.kind must be library, page, document, or data_source",
  );
};

const readCausalDependencies = (value: unknown): readonly BlockTransferDocumentHead[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) {
    throw new BlockTransferContractError(
      "blockTransferIntent.causalDependencies must contain at most 16 heads",
    );
  }
  const dependencies = value.map((entry, index) => {
    const dependency = readRecord(entry, `blockTransferIntent.causalDependencies[${index}]`);
    assertExactKeys(dependency, `blockTransferIntent.causalDependencies[${index}]`, [
      "documentId",
      "generation",
      "expectedHeadSeq",
    ]);
    return {
      documentId: readString(
        dependency,
        "documentId",
        `blockTransferIntent.causalDependencies[${index}]`,
      ),
      generation: readInteger(
        dependency,
        "generation",
        `blockTransferIntent.causalDependencies[${index}]`,
        1,
      ),
      expectedHeadSeq: readInteger(
        dependency,
        "expectedHeadSeq",
        `blockTransferIntent.causalDependencies[${index}]`,
        0,
      ),
    } satisfies BlockTransferDocumentHead;
  });
  if (new Set(dependencies.map(({ documentId }) => documentId)).size !== dependencies.length) {
    throw new BlockTransferContractError(
      "blockTransferIntent.causalDependencies must contain unique documents",
    );
  }
  return dependencies;
};

const assertParentChange = (
  mode: BlockTransferMode,
  source: BlockTransferIntentSource | BlockTransferSource,
  target: BlockTransferIntentTarget | BlockTransferTarget,
  label: string,
): void => {
  if (mode !== "move") return;
  if (source.kind === "page" && target.kind === "page" && source.pageId === target.pageId) {
    throw new BlockTransferContractError(
      `${label} is for parent changes; reorder within one Page uses a Yjs transaction`,
    );
  }
  if (
    source.kind === "document" &&
    target.kind === "document" &&
    source.documentId === target.documentId
  ) {
    throw new BlockTransferContractError(
      `${label} is for parent changes; reorder within one Document uses a Yjs transaction`,
    );
  }
  if (
    source.kind === "data_source" &&
    target.kind === "data_source" &&
    source.dataSourceId === target.dataSourceId
  ) {
    throw new BlockTransferContractError(
      `${label} is for parent changes; reorder within one Data Source uses a View position operation`,
    );
  }
};

export const parseBlockTransferIntent = (value: unknown): BlockTransferIntent => {
  const intent = readRecord(value, "blockTransferIntent");
  assertExactKeys(
    intent,
    "blockTransferIntent",
    [
      "operationId",
      "projectId",
      "storeEpoch",
      "actor",
      "mode",
      "rootBlockIds",
      "source",
      "target",
      "promotionPolicy",
    ],
    ["clientSessionId", "causalDependencies"],
  );
  if (intent.mode !== "move" && intent.mode !== "copy") {
    throw new BlockTransferContractError("blockTransferIntent.mode must be move or copy");
  }
  if (intent.promotionPolicy !== "literal" && intent.promotionPolicy !== "task_shorthand_v1") {
    throw new BlockTransferContractError(
      "blockTransferIntent.promotionPolicy must be literal or task_shorthand_v1",
    );
  }
  const rootBlockIds = readRootBlockIds(intent);
  const causalDependencies = readCausalDependencies(intent.causalDependencies);
  const source = parseIntentSource(intent.source);
  const target = parseIntentTarget(intent.target, rootBlockIds);
  assertParentChange(intent.mode, source, target, "BlockTransfer");
  return {
    operationId: readString(intent, "operationId", "blockTransferIntent"),
    projectId: readString(intent, "projectId", "blockTransferIntent"),
    storeEpoch: readString(intent, "storeEpoch", "blockTransferIntent"),
    ...(intent.clientSessionId === undefined
      ? {}
      : {
          clientSessionId: readString(intent, "clientSessionId", "blockTransferIntent"),
        }),
    actor: readActor(intent.actor),
    mode: intent.mode,
    rootBlockIds,
    causalDependencies,
    source,
    target,
    promotionPolicy: intent.promotionPolicy,
  };
};

export const blockTransferIntentFromRequest = (
  value: BlockTransferRequest,
): BlockTransferIntent => {
  const request = parseBlockTransferRequest(value);
  const source: BlockTransferIntentSource = (() => {
    if (request.source.kind === "library") {
      return { kind: "library", libraryId: request.source.libraryId };
    }
    if (request.source.kind === "page") {
      return { kind: "page", pageId: request.source.pageId };
    }
    if (request.source.kind === "document") {
      return { kind: "document", documentId: request.source.documentId };
    }
    return {
      kind: "data_source",
      dataSourceId: request.source.dataSourceId,
    };
  })();
  const target: BlockTransferIntentTarget = (() => {
    if (request.target.kind === "library") {
      return {
        kind: "library",
        libraryId: request.target.libraryId,
        ...(request.target.beforeBlockId ? { beforeBlockId: request.target.beforeBlockId } : {}),
      };
    }
    if (request.target.kind === "page" || request.target.kind === "document") {
      const anchors = {
        ...(request.target.parentBlockId ? { parentBlockId: request.target.parentBlockId } : {}),
        ...(request.target.beforeBlockId ? { beforeBlockId: request.target.beforeBlockId } : {}),
      };
      return request.target.kind === "page"
        ? { kind: "page", pageId: request.target.pageId, ...anchors }
        : { kind: "document", documentId: request.target.documentId, ...anchors };
    }
    return {
      kind: "data_source",
      dataSourceId: request.target.dataSourceId,
      placement: {
        kind: "direct",
        viewId: request.target.viewId,
        preferencesOverride: { rulesOverride: {}, presentationOverride: {} },
        groupKey: request.target.groupKey,
        ...(request.target.beforePageId ? { beforePageId: request.target.beforePageId } : {}),
      },
    };
  })();
  return {
    operationId: request.operationId,
    projectId: request.projectId,
    storeEpoch: request.storeEpoch,
    ...(request.clientSessionId ? { clientSessionId: request.clientSessionId } : {}),
    actor: request.actor,
    mode: request.mode,
    rootBlockIds: request.rootBlockIds,
    causalDependencies: [],
    source,
    target,
    promotionPolicy: "literal",
  };
};

export const canonicalizeBlockTransferLogicalIntent = (value: unknown): string => {
  const intent = parseBlockTransferIntent(value);
  return stableStringifyDatabaseJson({
    operationId: intent.operationId,
    projectId: intent.projectId,
    storeEpoch: intent.storeEpoch,
    actor: intent.actor,
    mode: intent.mode,
    rootBlockIds: intent.rootBlockIds,
    source: intent.source,
    target: intent.target,
    promotionPolicy: intent.promotionPolicy,
  });
};

export const parseBlockTransferRequest = (value: unknown): BlockTransferRequest => {
  const request = readRecord(value, "blockTransfer");
  assertExactKeys(
    request,
    "blockTransfer",
    [
      "operationId",
      "projectId",
      "storeEpoch",
      "actor",
      "mode",
      "rootBlockIds",
      "expectedLocationRevisions",
      "source",
      "target",
    ],
    ["clientSessionId"],
  );
  if (request.mode !== "move" && request.mode !== "copy") {
    throw new BlockTransferContractError("blockTransfer.mode must be move or copy");
  }
  const rootBlockIds = readRootBlockIds(request);
  const source = parseSource(request.source, rootBlockIds);
  const target = parseTarget(request.target, rootBlockIds);
  assertParentChange(request.mode, source, target, "BlockTransfer");
  return {
    operationId: readString(request, "operationId", "blockTransfer"),
    projectId: readString(request, "projectId", "blockTransfer"),
    storeEpoch: readString(request, "storeEpoch", "blockTransfer"),
    ...(request.clientSessionId === undefined
      ? {}
      : {
          clientSessionId: readString(request, "clientSessionId", "blockTransfer"),
        }),
    actor: readActor(request.actor),
    mode: request.mode,
    rootBlockIds,
    expectedLocationRevisions: readExpectedLocationRevisions(request, rootBlockIds),
    source,
    target,
  };
};

export const parseBlockTransferUndoToken = (value: unknown): BlockTransferUndoToken => {
  const token = readRecord(value, "blockTransferUndo.token");
  assertExactKeys(token, "blockTransferUndo.token", [
    "transferOperationId",
    "recipeHash",
    "storeEpoch",
  ]);
  const recipeHash = readString(token, "recipeHash", "blockTransferUndo.token", 64);
  if (!/^[0-9a-f]{64}$/.test(recipeHash)) {
    throw new BlockTransferContractError(
      "blockTransferUndo.token.recipeHash must be a SHA-256 digest",
    );
  }
  return {
    transferOperationId: readString(token, "transferOperationId", "blockTransferUndo.token"),
    recipeHash,
    storeEpoch: readString(token, "storeEpoch", "blockTransferUndo.token"),
  };
};

export const parseBlockTransferUndoIntent = (value: unknown): BlockTransferUndoIntent => {
  const intent = readRecord(value, "blockTransferUndo");
  assertExactKeys(intent, "blockTransferUndo", ["operationId", "projectId", "storeEpoch", "token"]);
  const storeEpoch = readString(intent, "storeEpoch", "blockTransferUndo");
  const token = parseBlockTransferUndoToken(intent.token);
  if (token.storeEpoch !== storeEpoch) {
    throw new BlockTransferContractError("blockTransferUndo token belongs to another store epoch");
  }
  return {
    operationId: readString(intent, "operationId", "blockTransferUndo"),
    projectId: readString(intent, "projectId", "blockTransferUndo"),
    storeEpoch,
    token,
  };
};

/** Canonical semantic identity. Transport/session attempt identity is excluded. */
export const canonicalizeBlockTransferIntent = (value: unknown): string => {
  const request = parseBlockTransferRequest(value);
  return stableStringifyDatabaseJson({
    operationId: request.operationId,
    projectId: request.projectId,
    storeEpoch: request.storeEpoch,
    actor: request.actor,
    mode: request.mode,
    rootBlockIds: request.rootBlockIds,
    expectedLocationRevisions: request.expectedLocationRevisions,
    source: request.source,
    target: request.target,
  });
};
