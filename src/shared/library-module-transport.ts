import { parseDatabaseId, parseDatabaseViewId, parseDataSourceId } from "./database-identities";
import type { DatabaseViewLayout } from "./database-kernel";
import { parseLibraryBlockPropertyMutationRequestV2 } from "./block-property-mutations-v2";
import { bindLibraryDatabaseApplyV2 } from "./database-module-v2-transport";
import { parseLocalCommitApply } from "./local-commit-delivery";
import {
  assertExistingCanvasBlockId,
  assertExistingCanvasDocumentId,
} from "./block-documents/canvas-document-identity";
import {
  DEFAULT_LIBRARY_READ_LIMIT,
  MAX_LIBRARY_CURSOR_LENGTH,
  MAX_LIBRARY_QUERY_LENGTH,
  MAX_LIBRARY_PROJECT_ACCESS_CHANGES,
  MAX_LIBRARY_READ_LIMIT,
  type LibraryCatalogEntry,
  type LibraryCanvasDestination,
  type LibraryCanvasTarget,
  type LibraryModuleApplyReceipt,
  type LibraryModuleApplyRequest,
  type LibraryModuleApplyResult,
  type LibraryModuleError,
  type LibraryModuleErrorCode,
  type LibraryModuleReadRequest,
  type LibraryModuleReadResult,
  type LibraryMoveDestinationEntry,
  type LibraryMoveDestinationScope,
  type LibraryPageReferenceCandidate,
  type LibraryPageFileBodyUsage,
  type LibraryPageFileOwnershipMove,
  type LibraryNavigationNode,
  type LibraryNavigationParent,
  type LibraryPlacementAnchor,
  type LibraryReadValue,
  type LibraryRouteTarget,
  type LibraryStructuralReplacementBlock,
  type LibraryWriteParent,
} from "./library-module";
import { isWorkflowStatus } from "./workflow-status";
import type { PageSearchMatch, PageSearchTextPart } from "./types";
import { parseAuthorizedReadStamp } from "./authorized-read-stamp";
import {
  PROJECT_MARKER_COLORS,
  PROJECT_MARKER_ICONS,
  type ProjectAppearance,
} from "./project-appearance";
import { assertUuidV7 } from "./uuid-v7";
import { canonicalizePortableRichText } from "./block-documents/portable-rich-text";

const MAX_ID_LENGTH = 512;
const MAX_TITLE_LENGTH = 1_000_000;
const MAX_STRUCTURAL_ROOTS = 10_000;
const MAX_STRUCTURAL_REPLACEMENT_BYTES = 64 * 1024 * 1024;
const MAX_STRUCTURAL_REPLACEMENT_DEPTH = 128;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

const displayText = (value: unknown, label: string): string => {
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TITLE_LENGTH &&
    !value.includes("\0")
  ) {
    return value;
  }
  throw new TypeError(`${label} must be bounded display text`);
};

const parsePageSearchParts = (value: unknown, label: string): PageSearchTextPart[] => {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value.map((entry, index) => {
    const part = record(entry, `${label}[${index}]`);
    exactKeys(part, `${label}[${index}]`, ["text", "highlighted"]);
    return {
      text: displayText(part.text, `${label}[${index}].text`),
      highlighted: boolean(part.highlighted, `${label}[${index}].highlighted`),
    };
  });
};

const parsePageSearchMatch = (value: unknown, label: string): PageSearchMatch => {
  const match = record(value, label);
  const source = string(match.source, `${label}.source`);
  const quality = string(match.quality, `${label}.quality`);
  if (quality !== "exact" && quality !== "prefix" && quality !== "fuzzy") {
    throw new TypeError(`${label}.quality is unsupported`);
  }
  if (source === "page_key") {
    exactKeys(match, label, ["source", "quality", "pageKey", "isCurrent", "parts"]);
    return {
      source,
      quality,
      pageKey: string(match.pageKey, `${label}.pageKey`),
      isCurrent: boolean(match.isCurrent, `${label}.isCurrent`),
      parts: parsePageSearchParts(match.parts, `${label}.parts`),
    };
  }
  if (source === "identity" || source === "title") {
    exactKeys(match, label, ["source", "quality", "parts"]);
    return {
      source,
      quality,
      parts: parsePageSearchParts(match.parts, `${label}.parts`),
    };
  }
  if (source === "property") {
    exactKeys(match, label, ["source", "quality", "propertyId", "propertyName", "parts"]);
    return {
      source,
      quality,
      propertyId: string(match.propertyId, `${label}.propertyId`),
      propertyName: string(match.propertyName, `${label}.propertyName`),
      parts: parsePageSearchParts(match.parts, `${label}.parts`),
    };
  }
  if (source === "body") {
    exactKeys(match, label, ["source", "quality", "blockId", "blockType", "parts"]);
    return {
      source,
      quality,
      blockId: string(match.blockId, `${label}.blockId`),
      blockType: string(match.blockType, `${label}.blockType`),
      parts: parsePageSearchParts(match.parts, `${label}.parts`),
    };
  }
  throw new TypeError(`${label}.source is unsupported`);
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  if (isRecord(value)) return value;
  throw new TypeError(`${label} must be an object`);
};

const exactKeys = (
  value: Readonly<Record<string, unknown>>,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void => {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (Object.hasOwn(value, key)) continue;
    throw new TypeError(`${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    throw new TypeError(`${label}.${key} is not supported`);
  }
};

const string = (
  value: unknown,
  label: string,
  maximum = MAX_ID_LENGTH,
  allowEmpty = false,
): string => {
  if (
    typeof value === "string" &&
    value.length <= maximum &&
    (allowEmpty || value.length > 0) &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return value;
  }
  throw new TypeError(`${label} must be a canonical bounded string`);
};

const optionalString = (value: unknown, label: string, maximum: number): string | undefined =>
  value === undefined ? undefined : string(value, label, maximum, true);

const revision = (value: unknown, label: string): number => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw new TypeError(`${label} must be a safe non-negative integer`);
};

const uuidV7 = (value: unknown, label: string): string => assertUuidV7(string(value, label), label);

const existingCanvasBlockId = (value: unknown, label: string): string =>
  assertExistingCanvasBlockId(string(value, label), label);

const existingCanvasDocumentId = (value: unknown, label: string): string =>
  assertExistingCanvasDocumentId(string(value, label), label);

const parseLibraryDocumentHead = (
  value: unknown,
  label: string,
): {
  readonly documentId: string;
  readonly generation: number;
  readonly expectedHeadSeq: number;
} => {
  const head = record(value, label);
  exactKeys(head, label, ["documentId", "generation", "expectedHeadSeq"]);
  const generation = revision(head.generation, `${label}.generation`);
  if (generation < 1) {
    throw new TypeError(`${label}.generation must be positive`);
  }
  return {
    documentId: string(head.documentId, `${label}.documentId`),
    generation,
    expectedHeadSeq: revision(head.expectedHeadSeq, `${label}.expectedHeadSeq`),
  };
};

const sha256Hex = (value: unknown, label: string): string => {
  const parsed = string(value, label, 64);
  if (SHA256_HEX_PATTERN.test(parsed)) return parsed;
  throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
};

const parseStructuralClipboardToken = (
  value: unknown,
  label: string,
): {
  readonly bundleId: string;
  readonly capability: string;
  readonly manifestHash: string;
  readonly storeEpoch: string;
} => {
  const token = record(value, label);
  exactKeys(token, label, ["bundleId", "capability", "manifestHash", "storeEpoch"]);
  return {
    bundleId: string(token.bundleId, `${label}.bundleId`),
    capability: sha256Hex(token.capability, `${label}.capability`),
    manifestHash: sha256Hex(token.manifestHash, `${label}.manifestHash`),
    storeEpoch: string(token.storeEpoch, `${label}.storeEpoch`),
  };
};

const parseStructuralHistoryToken = (
  value: unknown,
  label: string,
): {
  readonly recipeOperationId: string;
  readonly recipeHash: string;
  readonly storeEpoch: string;
} => {
  const token = record(value, label);
  exactKeys(token, label, ["recipeOperationId", "recipeHash", "storeEpoch"]);
  return {
    recipeOperationId: string(token.recipeOperationId, `${label}.recipeOperationId`),
    recipeHash: sha256Hex(token.recipeHash, `${label}.recipeHash`),
    storeEpoch: string(token.storeEpoch, `${label}.storeEpoch`),
  };
};

const parseStructuralSelection = (value: unknown, label: string) => {
  const selection = record(value, label);
  exactKeys(selection, label, ["sourceDocumentId", "rootBlockIds", "sourceHead"]);
  if (
    !Array.isArray(selection.rootBlockIds) ||
    selection.rootBlockIds.length === 0 ||
    selection.rootBlockIds.length > MAX_STRUCTURAL_ROOTS
  ) {
    throw new TypeError(`${label}.rootBlockIds must contain 1 to ${MAX_STRUCTURAL_ROOTS} Blocks`);
  }
  const rootBlockIds = selection.rootBlockIds.map((candidate, index) =>
    string(candidate, `${label}.rootBlockIds[${index}]`),
  );
  if (new Set(rootBlockIds).size !== rootBlockIds.length) {
    throw new TypeError(`${label}.rootBlockIds must contain unique Blocks`);
  }
  const sourceDocumentId = string(selection.sourceDocumentId, `${label}.sourceDocumentId`);
  const sourceHead = parseLibraryDocumentHead(selection.sourceHead, `${label}.sourceHead`);
  if (sourceHead.documentId !== sourceDocumentId) {
    throw new TypeError(`${label}.sourceHead must target sourceDocumentId`);
  }
  return { sourceDocumentId, rootBlockIds, sourceHead };
};

const parseStructuralTarget = (value: unknown, label: string) => {
  const target = record(value, label);
  exactKeys(target, label, ["targetDocumentId", "parentBlockId", "beforeBlockId", "targetHead"]);
  const targetDocumentId = string(target.targetDocumentId, `${label}.targetDocumentId`);
  const targetHead = parseLibraryDocumentHead(target.targetHead, `${label}.targetHead`);
  if (targetHead.documentId !== targetDocumentId) {
    throw new TypeError(`${label}.targetHead must target targetDocumentId`);
  }
  return {
    targetDocumentId,
    parentBlockId:
      target.parentBlockId === null ? null : string(target.parentBlockId, `${label}.parentBlockId`),
    beforeBlockId:
      target.beforeBlockId === null ? null : string(target.beforeBlockId, `${label}.beforeBlockId`),
    targetHead,
  };
};

const parseStructuralJson = (value: unknown, label: string): unknown => {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value, (_key, candidate: unknown) => {
      if (typeof candidate === "number" && !Number.isFinite(candidate)) {
        throw new TypeError(`${label} must contain only finite JSON values`);
      }
      if (
        candidate === undefined ||
        typeof candidate === "bigint" ||
        typeof candidate === "function" ||
        typeof candidate === "symbol"
      ) {
        throw new TypeError(`${label} must contain only JSON values`);
      }
      return candidate;
    });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`${label} must contain only JSON values`, { cause: error });
  }
  if (encoded === undefined || encoded.length > MAX_STRUCTURAL_REPLACEMENT_BYTES) {
    throw new TypeError(`${label} exceeds its JSON bound`);
  }
  return JSON.parse(encoded) as unknown;
};

const parseStructuralReplacementBlocks = (value: unknown, label: string) => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_STRUCTURAL_ROOTS) {
    throw new TypeError(`${label} must contain 1 to ${MAX_STRUCTURAL_ROOTS} Blocks`);
  }
  let count = 0;
  const parseBlock = (
    candidate: unknown,
    blockLabel: string,
    depth: number,
  ): LibraryStructuralReplacementBlock => {
    if (depth > MAX_STRUCTURAL_REPLACEMENT_DEPTH) {
      throw new TypeError(`${blockLabel} exceeds its nesting bound`);
    }
    count += 1;
    if (count > MAX_STRUCTURAL_ROOTS) {
      throw new TypeError(`${label} exceeds its Block bound`);
    }
    const block = record(candidate, blockLabel);
    exactKeys(block, blockLabel, ["blockType", "props", "content", "children"]);
    const props = record(block.props, `${blockLabel}.props`);
    if (!Array.isArray(block.children)) {
      throw new TypeError(`${blockLabel}.children must be an array`);
    }
    return {
      blockType: string(block.blockType, `${blockLabel}.blockType`, 128),
      props: parseStructuralJson(props, `${blockLabel}.props`) as Readonly<Record<string, unknown>>,
      content:
        block.content === null ? null : parseStructuralJson(block.content, `${blockLabel}.content`),
      children: block.children.map((child, index) =>
        parseBlock(child, `${blockLabel}.children[${index}]`, depth + 1),
      ),
    };
  };
  const blocks = value.map((block, index) => parseBlock(block, `${label}[${index}]`, 0));
  parseStructuralJson(blocks, label);
  return blocks;
};

const parseStructuralTurnIntoTarget = (value: unknown, label: string) => {
  const target = record(value, label);
  if (target.kind === "heading") {
    exactKeys(target, label, ["kind", "level", "toggleable"]);
    if (target.level !== "one" && target.level !== "two" && target.level !== "three") {
      throw new TypeError(`${label}.level is unsupported`);
    }
    return {
      kind: target.kind,
      level: target.level,
      toggleable: boolean(target.toggleable, `${label}.toggleable`),
    } as const;
  }
  if (
    target.kind === "paragraph" ||
    target.kind === "bulleted_list" ||
    target.kind === "numbered_list" ||
    target.kind === "todo_list" ||
    target.kind === "toggle_list" ||
    target.kind === "quote" ||
    target.kind === "callout" ||
    target.kind === "code" ||
    target.kind === "equation"
  ) {
    exactKeys(target, label, ["kind"]);
    return { kind: target.kind } as const;
  }
  throw new TypeError(`${label}.kind is unsupported`);
};

const boolean = (value: unknown, label: string): boolean => {
  if (typeof value === "boolean") return value;
  throw new TypeError(`${label} must be a boolean`);
};

const bytes = (value: unknown, label: string): Uint8Array => {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (
    Array.isArray(value) &&
    value.every(
      (entry) => typeof entry === "number" && Number.isInteger(entry) && entry >= 0 && entry <= 255,
    )
  ) {
    return Uint8Array.from(value);
  }
  throw new TypeError(`${label} must be a byte array`);
};

const readLimit = (value: unknown, label: string): number | undefined => {
  if (value === undefined) return undefined;
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_LIBRARY_READ_LIMIT
  ) {
    return value;
  }
  throw new TypeError(`${label} must be between 1 and ${MAX_LIBRARY_READ_LIMIT}`);
};

const parseRouteTarget = (value: unknown, label: string): LibraryRouteTarget => {
  const target = record(value, label);
  if (target.kind === "page") {
    exactKeys(target, label, ["kind", "pageId"]);
    return { kind: "page", pageId: string(target.pageId, `${label}.pageId`) };
  }
  if (target.kind === "database") {
    exactKeys(target, label, ["kind", "databaseId"]);
    return {
      kind: "database",
      databaseId: parseDatabaseId(target.databaseId),
    };
  }
  if (target.kind === "canvas") {
    exactKeys(target, label, ["kind", "canvasId"]);
    return {
      kind: "canvas",
      canvasId: existingCanvasBlockId(target.canvasId, `${label}.canvasId`),
    };
  }
  if (target.kind === "view") {
    exactKeys(target, label, ["kind", "viewId"]);
    return { kind: "view", viewId: parseDatabaseViewId(target.viewId) };
  }
  throw new TypeError(`${label}.kind is unsupported`);
};

const parseNavigationParent = (value: unknown, label: string): LibraryNavigationParent => {
  const parent = record(value, label);
  if (parent.kind === "library") {
    exactKeys(parent, label, ["kind"]);
    return { kind: "library" };
  }
  if (parent.kind === "page") {
    exactKeys(parent, label, ["kind", "pageId"]);
    return { kind: "page", pageId: string(parent.pageId, `${label}.pageId`) };
  }
  if (parent.kind === "database") {
    exactKeys(parent, label, ["kind", "databaseId"]);
    return {
      kind: "database",
      databaseId: parseDatabaseId(parent.databaseId),
    };
  }
  throw new TypeError(`${label}.kind is unsupported`);
};

const parseMoveDestinationScope = (value: unknown, label: string): LibraryMoveDestinationScope => {
  const scope = record(value, label);
  if (scope.kind === "suggested") {
    exactKeys(scope, label, ["kind"]);
    return { kind: "suggested" };
  }
  if (scope.kind === "search") {
    exactKeys(scope, label, ["kind", "query"]);
    return {
      kind: "search",
      query: string(scope.query, `${label}.query`, MAX_LIBRARY_QUERY_LENGTH),
    };
  }
  if (scope.kind === "children") {
    exactKeys(scope, label, ["kind", "parent"]);
    const parent = parseNavigationParent(scope.parent, `${label}.parent`);
    if (parent.kind === "database") {
      throw new TypeError(`${label}.parent cannot be a Database`);
    }
    return { kind: "children", parent };
  }
  throw new TypeError(`${label}.kind is unsupported`);
};

const parsePlacementAnchor = (value: unknown, label: string): LibraryPlacementAnchor => {
  const anchor = record(value, label);
  exactKeys(anchor, label, ["blockId", "expectedLocationRevision"]);
  return {
    blockId: string(anchor.blockId, `${label}.blockId`),
    expectedLocationRevision: revision(
      anchor.expectedLocationRevision,
      `${label}.expectedLocationRevision`,
    ),
  };
};

const parseWriteParent = (value: unknown, label: string): LibraryWriteParent => {
  const parent = record(value, label);
  const before =
    parent.before === undefined
      ? undefined
      : parsePlacementAnchor(parent.before, `${label}.before`);
  if (parent.kind === "library") {
    exactKeys(parent, label, ["kind"], ["before"]);
    return { kind: "library", ...(before ? { before } : {}) };
  }
  if (parent.kind === "page") {
    exactKeys(
      parent,
      label,
      ["kind", "pageId", "expectedDocumentGeneration", "expectedDocumentHeadSeq"],
      ["before", "insertion"],
    );
    const expectedDocumentGeneration = revision(
      parent.expectedDocumentGeneration,
      `${label}.expectedDocumentGeneration`,
    );
    if (expectedDocumentGeneration < 1) {
      throw new TypeError(`${label}.expectedDocumentGeneration must be positive`);
    }
    return {
      kind: "page",
      pageId: string(parent.pageId, `${label}.pageId`),
      expectedDocumentGeneration,
      expectedDocumentHeadSeq: revision(
        parent.expectedDocumentHeadSeq,
        `${label}.expectedDocumentHeadSeq`,
      ),
      ...(before ? { before } : {}),
      ...(parent.insertion === undefined
        ? {}
        : {
            insertion: parsePageInsertion(parent.insertion, `${label}.insertion`),
          }),
    };
  }
  throw new TypeError(`${label}.kind is unsupported`);
};

function parsePageInsertion(
  value: unknown,
  label: string,
): import("./library-module").LibraryPageInsertion {
  const insertion = record(value, label);
  if (insertion.kind === "append") {
    exactKeys(insertion, label, ["kind"], ["parentBlockId"]);
    return {
      kind: "append",
      ...(insertion.parentBlockId === undefined
        ? {}
        : { parentBlockId: uuidV7(insertion.parentBlockId, `${label}.parentBlockId`) }),
    };
  }
  if (insertion.kind === "before") {
    exactKeys(insertion, label, ["kind", "anchorBlockId"], ["parentBlockId"]);
    return {
      kind: "before",
      anchorBlockId: uuidV7(insertion.anchorBlockId, `${label}.anchorBlockId`),
      ...(insertion.parentBlockId === undefined
        ? {}
        : { parentBlockId: uuidV7(insertion.parentBlockId, `${label}.parentBlockId`) }),
    };
  }
  if (insertion.kind === "replace_empty_paragraph") {
    exactKeys(insertion, label, ["kind", "blockId"]);
    return {
      kind: "replace_empty_paragraph",
      blockId: uuidV7(insertion.blockId, `${label}.blockId`),
    };
  }
  throw new TypeError(`${label}.kind is unsupported`);
}

const parseCanvasDestination = (value: unknown, label: string): LibraryCanvasDestination => {
  const destination = record(value, label);
  if (destination.kind === "library") {
    exactKeys(destination, label, ["kind"], ["before"]);
    const before =
      destination.before === undefined
        ? undefined
        : parsePlacementAnchor(destination.before, `${label}.before`);
    return { kind: "library", ...(before ? { before } : {}) };
  }
  if (destination.kind !== "page") {
    throw new TypeError(`${label}.kind is unsupported`);
  }
  exactKeys(destination, label, [
    "kind",
    "pageId",
    "expectedDocumentGeneration",
    "expectedDocumentHeadSeq",
    "insertion",
  ]);
  const parsedInsertion = parsePageInsertion(destination.insertion, `${label}.insertion`);
  const expectedDocumentGeneration = revision(
    destination.expectedDocumentGeneration,
    `${label}.expectedDocumentGeneration`,
  );
  if (expectedDocumentGeneration < 1) {
    throw new TypeError(`${label}.expectedDocumentGeneration must be positive`);
  }
  return {
    kind: "page",
    pageId: uuidV7(destination.pageId, `${label}.pageId`),
    expectedDocumentGeneration,
    expectedDocumentHeadSeq: revision(
      destination.expectedDocumentHeadSeq,
      `${label}.expectedDocumentHeadSeq`,
    ),
    insertion: parsedInsertion,
  };
};

const parsePageMentionDocumentTarget = (value: unknown, label: string) => {
  const target = record(value, label);
  const expectedDocumentGeneration = revision(
    target.expectedDocumentGeneration,
    `${label}.expectedDocumentGeneration`,
  );
  if (expectedDocumentGeneration < 1) {
    throw new TypeError(`${label}.expectedDocumentGeneration must be positive`);
  }
  return {
    pageId: uuidV7(target.pageId, `${label}.pageId`),
    documentId: string(target.documentId, `${label}.documentId`),
    expectedDocumentGeneration,
    expectedDocumentHeadSeq: revision(
      target.expectedDocumentHeadSeq,
      `${label}.expectedDocumentHeadSeq`,
    ),
  };
};

const parseApplyResourceTarget = (
  value: unknown,
  label: string,
):
  | { readonly kind: "page"; readonly pageId: string }
  | { readonly kind: "database"; readonly databaseId: ReturnType<typeof parseDatabaseId> } => {
  const target = record(value, label);
  if (target.kind === "page") {
    exactKeys(target, label, ["kind", "pageId"]);
    return { kind: "page", pageId: string(target.pageId, `${label}.pageId`) };
  }
  if (target.kind === "database") {
    exactKeys(target, label, ["kind", "databaseId"]);
    return { kind: "database", databaseId: parseDatabaseId(target.databaseId) };
  }
  throw new TypeError(`${label}.kind is unsupported`);
};

export const bindLibraryModuleApply = (value: unknown): LibraryModuleApplyRequest => {
  const request = record(value, "libraryModuleApply");
  exactKeys(request, "libraryModuleApply", ["operationId", "storeEpoch", "operation"]);
  const operationId = uuidV7(request.operationId, "operationId");
  const storeEpoch = string(request.storeEpoch, "libraryModuleApply.storeEpoch");
  const operation = record(request.operation, "libraryModuleApply.operation");
  if (operation.kind === "create_page") {
    exactKeys(operation, "libraryModuleApply.operation", [
      "kind",
      "pageId",
      "documentId",
      "title",
      "parent",
    ]);
    return {
      operationId,
      storeEpoch,
      operation: {
        kind: "create_page",
        pageId: uuidV7(operation.pageId, "pageId"),
        documentId: uuidV7(operation.documentId, "documentId"),
        title: string(
          operation.title,
          "libraryModuleApply.operation.title",
          MAX_TITLE_LENGTH,
          true,
        ),
        parent: parseWriteParent(operation.parent, "libraryModuleApply.operation.parent"),
      },
    };
  }
  if (operation.kind === "create_page_mention") {
    exactKeys(operation, "libraryModuleApply.operation", [
      "kind",
      "pageId",
      "documentId",
      "title",
      "mentionHost",
      "destination",
    ]);
    const mentionHost = record(operation.mentionHost, "libraryModuleApply.operation.mentionHost");
    exactKeys(mentionHost, "libraryModuleApply.operation.mentionHost", [
      "pageId",
      "documentId",
      "expectedDocumentGeneration",
      "expectedDocumentHeadSeq",
      "blockId",
      "expectedContent",
      "replacementContent",
    ]);
    const destination = record(operation.destination, "libraryModuleApply.operation.destination");
    exactKeys(destination, "libraryModuleApply.operation.destination", [
      "pageId",
      "documentId",
      "expectedDocumentGeneration",
      "expectedDocumentHeadSeq",
      "insertion",
    ]);
    const parsedInsertion = parsePageInsertion(
      destination.insertion,
      "libraryModuleApply.operation.destination.insertion",
    );
    if (parsedInsertion.kind !== "append") {
      throw new TypeError("libraryModuleApply.operation.destination.insertion.kind must be append");
    }
    return {
      operationId,
      storeEpoch,
      operation: {
        kind: operation.kind,
        pageId: uuidV7(operation.pageId, "pageId"),
        documentId: uuidV7(operation.documentId, "documentId"),
        title: string(
          operation.title,
          "libraryModuleApply.operation.title",
          MAX_TITLE_LENGTH,
          true,
        ),
        mentionHost: {
          ...parsePageMentionDocumentTarget(
            mentionHost,
            "libraryModuleApply.operation.mentionHost",
          ),
          blockId: uuidV7(mentionHost.blockId, "libraryModuleApply.operation.mentionHost.blockId"),
          expectedContent: canonicalizePortableRichText(mentionHost.expectedContent),
          replacementContent: canonicalizePortableRichText(mentionHost.replacementContent),
        },
        destination: {
          ...parsePageMentionDocumentTarget(
            destination,
            "libraryModuleApply.operation.destination",
          ),
          insertion: parsedInsertion,
        },
      },
    };
  }
  if (operation.kind === "create_database") {
    exactKeys(operation, "libraryModuleApply.operation", [
      "kind",
      "databaseId",
      "dataSourceId",
      "viewId",
      "name",
      "parent",
    ]);
    return {
      operationId,
      storeEpoch,
      operation: {
        kind: "create_database",
        databaseId: parseDatabaseId(uuidV7(operation.databaseId, "databaseId")),
        dataSourceId: parseDataSourceId(uuidV7(operation.dataSourceId, "dataSourceId")),
        viewId: parseDatabaseViewId(uuidV7(operation.viewId, "viewId")),
        name: string(operation.name, "libraryModuleApply.operation.name", 256),
        parent: parseWriteParent(operation.parent, "libraryModuleApply.operation.parent"),
      },
    };
  }
  if (operation.kind === "create_canvas") {
    exactKeys(operation, "libraryModuleApply.operation", [
      "kind",
      "canvasId",
      "documentId",
      "displayName",
      "destination",
    ]);
    return {
      operationId,
      storeEpoch,
      operation: {
        kind: operation.kind,
        canvasId: uuidV7(operation.canvasId, "canvasId"),
        documentId: uuidV7(operation.documentId, "documentId"),
        displayName: string(operation.displayName, "libraryModuleApply.operation.displayName", 256),
        destination: parseCanvasDestination(
          operation.destination,
          "libraryModuleApply.operation.destination",
        ),
      },
    };
  }
  if (operation.kind === "rename_canvas") {
    exactKeys(operation, "libraryModuleApply.operation", [
      "kind",
      "canvasId",
      "displayName",
      "expectedMetadataRevision",
    ]);
    return {
      operationId,
      storeEpoch,
      operation: {
        kind: operation.kind,
        canvasId: existingCanvasBlockId(operation.canvasId, "canvasId"),
        displayName: string(operation.displayName, "libraryModuleApply.operation.displayName", 256),
        expectedMetadataRevision: revision(
          operation.expectedMetadataRevision,
          "libraryModuleApply.operation.expectedMetadataRevision",
        ),
      },
    };
  }
  if (operation.kind === "move_canvas") {
    exactKeys(operation, "libraryModuleApply.operation", [
      "kind",
      "canvasId",
      "expectedLocationRevision",
      "destination",
    ]);
    return {
      operationId,
      storeEpoch,
      operation: {
        kind: operation.kind,
        canvasId: existingCanvasBlockId(operation.canvasId, "canvasId"),
        expectedLocationRevision: revision(
          operation.expectedLocationRevision,
          "libraryModuleApply.operation.expectedLocationRevision",
        ),
        destination: parseCanvasDestination(
          operation.destination,
          "libraryModuleApply.operation.destination",
        ),
      },
    };
  }
  if (operation.kind === "duplicate_canvas") {
    exactKeys(
      operation,
      "libraryModuleApply.operation",
      [
        "kind",
        "sourceCanvasId",
        "canvasId",
        "documentId",
        "expectedDocumentGeneration",
        "expectedDocumentHeadSeq",
        "destination",
      ],
      ["displayName"],
    );
    const displayName = optionalString(
      operation.displayName,
      "libraryModuleApply.operation.displayName",
      256,
    );
    return {
      operationId,
      storeEpoch,
      operation: {
        kind: operation.kind,
        sourceCanvasId: existingCanvasBlockId(operation.sourceCanvasId, "sourceCanvasId"),
        canvasId: uuidV7(operation.canvasId, "canvasId"),
        documentId: uuidV7(operation.documentId, "documentId"),
        ...(displayName === undefined ? {} : { displayName }),
        expectedDocumentGeneration: revision(
          operation.expectedDocumentGeneration,
          "libraryModuleApply.operation.expectedDocumentGeneration",
        ),
        expectedDocumentHeadSeq: revision(
          operation.expectedDocumentHeadSeq,
          "libraryModuleApply.operation.expectedDocumentHeadSeq",
        ),
        destination: parseCanvasDestination(
          operation.destination,
          "libraryModuleApply.operation.destination",
        ),
      },
    };
  }
  if (operation.kind === "delete_canvas") {
    exactKeys(
      operation,
      "libraryModuleApply.operation",
      ["kind", "canvasId", "expectedLocationRevision", "expectedMetadataRevision"],
      ["containingDocumentHead"],
    );
    const containingDocumentHead =
      operation.containingDocumentHead === undefined
        ? undefined
        : parseLibraryDocumentHead(
            operation.containingDocumentHead,
            "libraryModuleApply.operation.containingDocumentHead",
          );
    return {
      operationId,
      storeEpoch,
      operation: {
        kind: operation.kind,
        canvasId: existingCanvasBlockId(operation.canvasId, "canvasId"),
        expectedLocationRevision: revision(
          operation.expectedLocationRevision,
          "libraryModuleApply.operation.expectedLocationRevision",
        ),
        expectedMetadataRevision: revision(
          operation.expectedMetadataRevision,
          "libraryModuleApply.operation.expectedMetadataRevision",
        ),
        ...(containingDocumentHead === undefined ? {} : { containingDocumentHead }),
      },
    };
  }
  if (operation.kind === "move_block") {
    exactKeys(operation, "libraryModuleApply.operation", ["kind", "target", "parent"]);
    const rawTarget = record(operation.target, "libraryModuleApply.operation.target");
    const expectedLocationRevision = revision(
      rawTarget.expectedLocationRevision,
      "libraryModuleApply.operation.target.expectedLocationRevision",
    );
    const target = parseApplyResourceTarget(
      Object.fromEntries(
        Object.entries(rawTarget).filter(([key]) => key !== "expectedLocationRevision"),
      ),
      "libraryModuleApply.operation.target",
    );
    if (expectedLocationRevision < 1) {
      throw new TypeError(
        "libraryModuleApply.operation.target.expectedLocationRevision must be positive",
      );
    }
    return {
      operationId,
      storeEpoch,
      operation: {
        kind: "move_block",
        target: { ...target, expectedLocationRevision },
        parent: parseWriteParent(operation.parent, "libraryModuleApply.operation.parent"),
      },
    };
  }
  if (operation.kind === "archive_resource" || operation.kind === "restore_resource") {
    exactKeys(operation, "libraryModuleApply.operation", ["kind", "target"]);
    const rawTarget = record(operation.target, "libraryModuleApply.operation.target");
    const expectedMetadataRevision = revision(
      rawTarget.expectedMetadataRevision,
      "libraryModuleApply.operation.target.expectedMetadataRevision",
    );
    const target = parseApplyResourceTarget(
      Object.fromEntries(
        Object.entries(rawTarget).filter(([key]) => key !== "expectedMetadataRevision"),
      ),
      "libraryModuleApply.operation.target",
    );
    if (expectedMetadataRevision < 1) {
      throw new TypeError(
        "libraryModuleApply.operation.target.expectedMetadataRevision must be positive",
      );
    }
    return {
      operationId,
      storeEpoch,
      operation: {
        kind: operation.kind,
        target: { ...target, expectedMetadataRevision },
      },
    };
  }
  if (operation.kind === "grant_project_access") {
    exactKeys(operation, "libraryModuleApply.operation", ["kind", "projectId", "target", "access"]);
    if (operation.access !== "read" && operation.access !== "read_write") {
      throw new TypeError("libraryModuleApply.operation.access is unsupported");
    }
    return {
      operationId,
      storeEpoch,
      operation: {
        kind: "grant_project_access",
        projectId: string(operation.projectId, "libraryModuleApply.operation.projectId"),
        target: parseApplyResourceTarget(operation.target, "libraryModuleApply.operation.target"),
        access: operation.access,
      },
    };
  }
  if (operation.kind === "set_project_access") {
    exactKeys(operation, "libraryModuleApply.operation", ["kind", "target", "changes"]);
    if (
      !Array.isArray(operation.changes) ||
      operation.changes.length === 0 ||
      operation.changes.length > MAX_LIBRARY_PROJECT_ACCESS_CHANGES
    ) {
      throw new TypeError(
        `libraryModuleApply.operation.changes must contain 1 to ${MAX_LIBRARY_PROJECT_ACCESS_CHANGES} Projects`,
      );
    }
    const changes = operation.changes.map((value, index) => {
      const label = `libraryModuleApply.operation.changes[${index}]`;
      const change = record(value, label);
      exactKeys(change, label, ["projectId", "access", "expectedRevision"]);
      if (change.access !== null && change.access !== "read" && change.access !== "read_write") {
        throw new TypeError(`${label}.access is unsupported`);
      }
      const access =
        change.access === null ? null : parseLibraryAccess(change.access, `${label}.access`);
      const expectedRevision =
        change.expectedRevision === null
          ? null
          : revision(change.expectedRevision, `${label}.expectedRevision`);
      if (expectedRevision !== null && expectedRevision < 1) {
        throw new TypeError(`${label}.expectedRevision must be positive`);
      }
      return {
        projectId: string(change.projectId, `${label}.projectId`),
        access,
        expectedRevision,
      };
    });
    if (new Set(changes.map((change) => change.projectId)).size !== changes.length) {
      throw new TypeError("libraryModuleApply.operation.changes must contain unique Projects");
    }
    return {
      operationId,
      storeEpoch,
      operation: {
        kind: operation.kind,
        target: parseApplyResourceTarget(operation.target, "libraryModuleApply.operation.target"),
        changes,
      },
    };
  }
  if (operation.kind === "apply_page_metadata_properties") {
    exactKeys(
      operation,
      "libraryModuleApply.operation",
      ["kind", "databaseOperations", "intrinsicFields"],
      ["clientSessionId"],
    );
    const database = bindLibraryDatabaseApplyV2({
      operationId,
      storeEpoch,
      operations: operation.databaseOperations,
    });
    if (database.operations.some((candidate) => candidate.kind !== "edit_property_values")) {
      throw new TypeError(
        "libraryModuleApply.operation.databaseOperations only supports Page Property value edits",
      );
    }
    const intrinsic = parseLibraryBlockPropertyMutationRequestV2({
      mutationId: operationId,
      storeEpoch,
      ...(operation.clientSessionId === undefined
        ? {}
        : { clientSessionId: operation.clientSessionId }),
      fields: operation.intrinsicFields,
    });
    return {
      operationId,
      storeEpoch,
      operation: {
        kind: operation.kind,
        ...(intrinsic.clientSessionId === undefined
          ? {}
          : { clientSessionId: intrinsic.clientSessionId }),
        databaseOperations: database.operations as readonly Extract<
          (typeof database.operations)[number],
          { readonly kind: "edit_property_values" }
        >[],
        intrinsicFields: intrinsic.fields,
      },
    };
  }
  if (operation.kind === "apply_page_file_changes") {
    exactKeys(
      operation,
      "libraryModuleApply.operation",
      ["kind", "pageId", "expectedManifestRevision", "changes"],
      ["turnId"],
    );
    if (!Array.isArray(operation.changes) || operation.changes.length === 0) {
      throw new TypeError("libraryModuleApply.operation.changes must be a non-empty array");
    }
    const changes = operation.changes.map((candidate, index) => {
      const label = `libraryModuleApply.operation.changes[${index}]`;
      const change = record(candidate, label);
      if (change.kind === "create") {
        exactKeys(change, label, [
          "kind",
          "fileId",
          "logicalPath",
          "mimeType",
          "preparedBlobReceiptId",
          "collisionPolicy",
        ]);
        return {
          kind: change.kind,
          fileId: string(change.fileId, `${label}.fileId`, MAX_ID_LENGTH),
          logicalPath: string(change.logicalPath, `${label}.logicalPath`, 1_024),
          mimeType: string(change.mimeType, `${label}.mimeType`, 255),
          preparedBlobReceiptId: string(
            change.preparedBlobReceiptId,
            `${label}.preparedBlobReceiptId`,
            MAX_ID_LENGTH,
          ),
          collisionPolicy: (() => {
            const policy = string(change.collisionPolicy, `${label}.collisionPolicy`);
            if (policy === "reject" || policy === "suffix") return policy;
            throw new TypeError(`${label}.collisionPolicy is invalid`);
          })(),
        } as const;
      }
      if (change.kind === "replace_content") {
        exactKeys(change, label, [
          "kind",
          "fileId",
          "expectedVersion",
          "mimeType",
          "preparedBlobReceiptId",
        ]);
        return {
          kind: change.kind,
          fileId: string(change.fileId, `${label}.fileId`, MAX_ID_LENGTH),
          expectedVersion: revision(change.expectedVersion, `${label}.expectedVersion`),
          mimeType: string(change.mimeType, `${label}.mimeType`, 255),
          preparedBlobReceiptId: string(
            change.preparedBlobReceiptId,
            `${label}.preparedBlobReceiptId`,
            MAX_ID_LENGTH,
          ),
        } as const;
      }
      if (change.kind === "rename") {
        exactKeys(change, label, ["kind", "fileId", "expectedVersion", "logicalPath"]);
        return {
          kind: change.kind,
          fileId: string(change.fileId, `${label}.fileId`, MAX_ID_LENGTH),
          expectedVersion: revision(change.expectedVersion, `${label}.expectedVersion`),
          logicalPath: string(change.logicalPath, `${label}.logicalPath`, 1_024),
        } as const;
      }
      if (change.kind === "delete") {
        exactKeys(change, label, ["kind", "fileId", "expectedVersion"]);
        return {
          kind: change.kind,
          fileId: string(change.fileId, `${label}.fileId`, MAX_ID_LENGTH),
          expectedVersion: revision(change.expectedVersion, `${label}.expectedVersion`),
        } as const;
      }
      if (change.kind === "restore_version") {
        exactKeys(change, label, ["kind", "fileId", "expectedVersion", "sourceVersion"]);
        return {
          kind: change.kind,
          fileId: string(change.fileId, `${label}.fileId`, MAX_ID_LENGTH),
          expectedVersion: revision(change.expectedVersion, `${label}.expectedVersion`),
          sourceVersion: revision(change.sourceVersion, `${label}.sourceVersion`),
        } as const;
      }
      if (change.kind === "clone_into_page") {
        exactKeys(change, label, [
          "kind",
          "sourcePageId",
          "sourceFileId",
          "targetFileId",
          "logicalPath",
        ]);
        return {
          kind: change.kind,
          sourcePageId: string(change.sourcePageId, `${label}.sourcePageId`, MAX_ID_LENGTH),
          sourceFileId: string(change.sourceFileId, `${label}.sourceFileId`, MAX_ID_LENGTH),
          targetFileId: string(change.targetFileId, `${label}.targetFileId`, MAX_ID_LENGTH),
          logicalPath: string(change.logicalPath, `${label}.logicalPath`, 1_024),
        } as const;
      }
      throw new TypeError(`${label}.kind is unsupported`);
    });
    return {
      operationId,
      storeEpoch,
      operation: {
        kind: operation.kind,
        pageId: string(operation.pageId, "libraryModuleApply.operation.pageId", MAX_ID_LENGTH),
        expectedManifestRevision: revision(
          operation.expectedManifestRevision,
          "libraryModuleApply.operation.expectedManifestRevision",
        ),
        ...(operation.turnId === undefined
          ? {}
          : {
              turnId: string(
                operation.turnId,
                "libraryModuleApply.operation.turnId",
                MAX_ID_LENGTH,
              ),
            }),
        changes,
      },
    };
  }
  if (operation.kind === "apply_structural_edit") {
    exactKeys(operation, "libraryModuleApply.operation", ["kind", "command"]);
    const command = record(operation.command, "libraryModuleApply.operation.command");
    if (command.kind === "capture_clipboard") {
      exactKeys(command, "libraryModuleApply.operation.command", ["kind", "selection"]);
      return {
        operationId,
        storeEpoch,
        operation: {
          kind: operation.kind,
          command: {
            kind: command.kind,
            selection: parseStructuralSelection(
              command.selection,
              "libraryModuleApply.operation.command.selection",
            ),
          },
        },
      };
    }
    if (command.kind === "delete_selection") {
      exactKeys(command, "libraryModuleApply.operation.command", [
        "kind",
        "selection",
        "reason",
        "direction",
      ]);
      if (command.direction !== "backward" && command.direction !== "forward") {
        throw new TypeError("libraryModuleApply.operation.command.direction is unsupported");
      }
      const reason = record(command.reason, "libraryModuleApply.operation.command.reason");
      const parsedReason = (() => {
        if (reason.kind === "delete") {
          exactKeys(reason, "libraryModuleApply.operation.command.reason", ["kind"]);
          return { kind: "delete" as const };
        }
        if (reason.kind === "cut") {
          exactKeys(reason, "libraryModuleApply.operation.command.reason", ["kind", "bundle"]);
          return {
            kind: "cut" as const,
            bundle: parseStructuralClipboardToken(
              reason.bundle,
              "libraryModuleApply.operation.command.reason.bundle",
            ),
          };
        }
        throw new TypeError("libraryModuleApply.operation.command.reason.kind is unsupported");
      })();
      return {
        operationId,
        storeEpoch,
        operation: {
          kind: operation.kind,
          command: {
            kind: command.kind,
            selection: parseStructuralSelection(
              command.selection,
              "libraryModuleApply.operation.command.selection",
            ),
            reason: parsedReason,
            direction: command.direction,
          },
        },
      };
    }
    if (command.kind === "paste_clipboard") {
      exactKeys(command, "libraryModuleApply.operation.command", ["kind", "bundle", "target"]);
      return {
        operationId,
        storeEpoch,
        operation: {
          kind: operation.kind,
          command: {
            kind: command.kind,
            bundle: parseStructuralClipboardToken(
              command.bundle,
              "libraryModuleApply.operation.command.bundle",
            ),
            target: parseStructuralTarget(
              command.target,
              "libraryModuleApply.operation.command.target",
            ),
          },
        },
      };
    }
    if (command.kind === "duplicate_selection" || command.kind === "move_selection") {
      exactKeys(command, "libraryModuleApply.operation.command", ["kind", "selection", "target"]);
      return {
        operationId,
        storeEpoch,
        operation: {
          kind: operation.kind,
          command: {
            kind: command.kind,
            selection: parseStructuralSelection(
              command.selection,
              "libraryModuleApply.operation.command.selection",
            ),
            target: parseStructuralTarget(
              command.target,
              "libraryModuleApply.operation.command.target",
            ),
          },
        },
      };
    }
    if (command.kind === "replace_selection") {
      exactKeys(command, "libraryModuleApply.operation.command", [
        "kind",
        "selection",
        "replacement",
      ]);
      const replacement = record(
        command.replacement,
        "libraryModuleApply.operation.command.replacement",
      );
      const parsedReplacement = (() => {
        if (replacement.kind === "clipboard") {
          exactKeys(replacement, "libraryModuleApply.operation.command.replacement", [
            "kind",
            "bundle",
          ]);
          return {
            kind: "clipboard" as const,
            bundle: parseStructuralClipboardToken(
              replacement.bundle,
              "libraryModuleApply.operation.command.replacement.bundle",
            ),
          };
        }
        if (replacement.kind === "blocks") {
          exactKeys(replacement, "libraryModuleApply.operation.command.replacement", [
            "kind",
            "blocks",
          ]);
          return {
            kind: "blocks" as const,
            blocks: parseStructuralReplacementBlocks(
              replacement.blocks,
              "libraryModuleApply.operation.command.replacement.blocks",
            ),
          };
        }
        throw new TypeError("libraryModuleApply.operation.command.replacement.kind is unsupported");
      })();
      return {
        operationId,
        storeEpoch,
        operation: {
          kind: operation.kind,
          command: {
            kind: command.kind,
            selection: parseStructuralSelection(
              command.selection,
              "libraryModuleApply.operation.command.selection",
            ),
            replacement: parsedReplacement,
          },
        },
      };
    }
    if (command.kind === "turn_selection_into") {
      exactKeys(command, "libraryModuleApply.operation.command", ["kind", "selection", "target"]);
      return {
        operationId,
        storeEpoch,
        operation: {
          kind: operation.kind,
          command: {
            kind: command.kind,
            selection: parseStructuralSelection(
              command.selection,
              "libraryModuleApply.operation.command.selection",
            ),
            target: parseStructuralTurnIntoTarget(
              command.target,
              "libraryModuleApply.operation.command.target",
            ),
          },
        },
      };
    }
    if (command.kind === "merge_block_backward") {
      exactKeys(command, "libraryModuleApply.operation.command", [
        "kind",
        "selection",
        "targetBlockId",
      ]);
      return {
        operationId,
        storeEpoch,
        operation: {
          kind: operation.kind,
          command: {
            kind: command.kind,
            selection: parseStructuralSelection(
              command.selection,
              "libraryModuleApply.operation.command.selection",
            ),
            targetBlockId: string(
              command.targetBlockId,
              "libraryModuleApply.operation.command.targetBlockId",
            ),
          },
        },
      };
    }
    if (command.kind === "release_history") {
      exactKeys(command, "libraryModuleApply.operation.command", ["kind", "tokens"]);
      if (!Array.isArray(command.tokens)) {
        throw new TypeError("libraryModuleApply.operation.command.tokens must be an array");
      }
      const tokens = command.tokens;
      if (tokens.length > 10_000) {
        throw new TypeError("libraryModuleApply.operation.command.tokens exceeds its bound");
      }
      return {
        operationId,
        storeEpoch,
        operation: {
          kind: operation.kind,
          command: {
            kind: command.kind,
            tokens: tokens.map((token, index) =>
              parseStructuralHistoryToken(
                token,
                `libraryModuleApply.operation.command.tokens[${index}]`,
              ),
            ),
          },
        },
      };
    }
    throw new TypeError("libraryModuleApply.operation.command.kind is unsupported");
  }
  if (operation.kind === "reverse_structural_edit") {
    exactKeys(operation, "libraryModuleApply.operation", ["kind", "token"]);
    return {
      operationId,
      storeEpoch,
      operation: {
        kind: operation.kind,
        token: parseStructuralHistoryToken(operation.token, "libraryModuleApply.operation.token"),
      },
    };
  }
  throw new TypeError("libraryModuleApply.operation.kind is unsupported");
};

const parseKinds = (
  value: unknown,
  label: string,
): readonly ("page" | "database" | "canvas")[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 3) {
    throw new TypeError(`${label} must be a bounded array`);
  }
  const parsed = value.map((entry) => {
    if (entry === "page" || entry === "database" || entry === "canvas") return entry;
    throw new TypeError(`${label} contains an unsupported kind`);
  });
  if (new Set(parsed).size !== parsed.length) {
    throw new TypeError(`${label} must contain unique kinds`);
  }
  return parsed;
};

export const bindLibraryModuleRead = (value: unknown): LibraryModuleReadRequest => {
  const request = record(value, "libraryModuleRead");
  exactKeys(request, "libraryModuleRead", ["read"]);
  const read = record(request.read, "libraryModuleRead.read");
  if (read.mode === "metadata") {
    exactKeys(read, "libraryModuleRead.read", ["mode"]);
    return { read: { mode: "metadata" } };
  }
  if (read.mode === "resource_project_access") {
    exactKeys(read, "libraryModuleRead.read", ["mode", "target"]);
    return {
      read: {
        mode: "resource_project_access",
        target: parseApplyResourceTarget(read.target, "libraryModuleRead.read.target"),
      },
    };
  }
  if (read.mode === "canvas_target") {
    exactKeys(read, "libraryModuleRead.read", ["mode", "canvasId"]);
    return {
      read: {
        mode: "canvas_target",
        canvasId: existingCanvasBlockId(read.canvasId, "libraryModuleRead.read.canvasId"),
      },
    };
  }
  if (read.mode === "children") {
    exactKeys(
      read,
      "libraryModuleRead.read",
      ["mode", "parent"],
      ["cursor", "limit", "forceIncludeTarget"],
    );
    const cursor = optionalString(
      read.cursor,
      "libraryModuleRead.read.cursor",
      MAX_LIBRARY_CURSOR_LENGTH,
    );
    const limit = readLimit(read.limit, "libraryModuleRead.read.limit");
    const forceIncludeTarget =
      read.forceIncludeTarget === undefined
        ? undefined
        : parseRouteTarget(read.forceIncludeTarget, "libraryModuleRead.read.forceIncludeTarget");
    return {
      read: {
        mode: "children",
        parent: parseNavigationParent(read.parent, "libraryModuleRead.read.parent"),
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
        ...(forceIncludeTarget === undefined ? {} : { forceIncludeTarget }),
      },
    };
  }
  if (read.mode === "standalone_roots") {
    exactKeys(read, "libraryModuleRead.read", ["mode"], ["cursor", "limit", "forceIncludeTarget"]);
    const cursor = optionalString(
      read.cursor,
      "libraryModuleRead.read.cursor",
      MAX_LIBRARY_CURSOR_LENGTH,
    );
    const limit = readLimit(read.limit, "libraryModuleRead.read.limit");
    const forceIncludeTarget =
      read.forceIncludeTarget === undefined
        ? undefined
        : parseApplyResourceTarget(
            read.forceIncludeTarget,
            "libraryModuleRead.read.forceIncludeTarget",
          );
    return {
      read: {
        mode: "standalone_roots",
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
        ...(forceIncludeTarget === undefined ? {} : { forceIncludeTarget }),
      },
    };
  }
  if (read.mode === "path") {
    exactKeys(read, "libraryModuleRead.read", ["mode", "target"]);
    return {
      read: {
        mode: "path",
        target: parseRouteTarget(read.target, "libraryModuleRead.read.target"),
      },
    };
  }
  if (read.mode === "catalog") {
    exactKeys(
      read,
      "libraryModuleRead.read",
      ["mode"],
      ["query", "kinds", "lifecycle", "cursor", "limit"],
    );
    const query = optionalString(
      read.query,
      "libraryModuleRead.read.query",
      MAX_LIBRARY_QUERY_LENGTH,
    );
    const kinds = parseKinds(read.kinds, "libraryModuleRead.read.kinds");
    if (
      read.lifecycle !== undefined &&
      read.lifecycle !== "active" &&
      read.lifecycle !== "archived"
    ) {
      throw new TypeError("libraryModuleRead.read.lifecycle is unsupported");
    }
    const cursor = optionalString(
      read.cursor,
      "libraryModuleRead.read.cursor",
      MAX_LIBRARY_CURSOR_LENGTH,
    );
    const limit = readLimit(read.limit, "libraryModuleRead.read.limit");
    return {
      read: {
        mode: "catalog",
        ...(query === undefined ? {} : { query }),
        ...(kinds === undefined ? {} : { kinds }),
        ...(read.lifecycle === undefined ? {} : { lifecycle: read.lifecycle }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      },
    };
  }
  if (read.mode === "move_destinations") {
    exactKeys(read, "libraryModuleRead.read", ["mode", "target", "scope"], ["cursor", "limit"]);
    const cursor = optionalString(
      read.cursor,
      "libraryModuleRead.read.cursor",
      MAX_LIBRARY_CURSOR_LENGTH,
    );
    const limit = readLimit(read.limit, "libraryModuleRead.read.limit");
    return {
      read: {
        mode: "move_destinations",
        target: parseApplyResourceTarget(read.target, "libraryModuleRead.read.target"),
        scope: parseMoveDestinationScope(read.scope, "libraryModuleRead.read.scope"),
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      },
    };
  }
  if (read.mode === "page_mention_destination") {
    exactKeys(read, "libraryModuleRead.read", ["mode", "pageId"]);
    return {
      read: {
        mode: read.mode,
        pageId: uuidV7(read.pageId, "libraryModuleRead.read.pageId"),
      },
    };
  }
  if (read.mode === "page_reference_candidates") {
    exactKeys(read, "libraryModuleRead.read", ["mode", "query"], ["limit", "sourcePageId"]);
    const query = string(
      read.query,
      "libraryModuleRead.read.query",
      MAX_LIBRARY_QUERY_LENGTH,
      true,
    );
    const limit = readLimit(read.limit, "libraryModuleRead.read.limit");
    if (limit !== undefined && limit > 60) {
      throw new TypeError("libraryModuleRead.read.limit must be at most 60");
    }
    const sourcePageId =
      read.sourcePageId === undefined
        ? undefined
        : string(read.sourcePageId, "libraryModuleRead.read.sourcePageId");
    return {
      read: {
        mode: "page_reference_candidates",
        query,
        ...(limit === undefined ? {} : { limit }),
        ...(sourcePageId === undefined ? {} : { sourcePageId }),
      },
    };
  }
  if (read.mode === "page_backlinks") {
    exactKeys(read, "libraryModuleRead.read", ["mode", "targetPageId"], ["cursor", "limit"]);
    const cursor = optionalString(
      read.cursor,
      "libraryModuleRead.read.cursor",
      MAX_LIBRARY_CURSOR_LENGTH,
    );
    const limit = readLimit(read.limit, "libraryModuleRead.read.limit");
    return {
      read: {
        mode: "page_backlinks",
        targetPageId: string(
          read.targetPageId,
          "libraryModuleRead.read.targetPageId",
          MAX_ID_LENGTH,
        ),
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      },
    };
  }
  if (read.mode === "page_files") {
    exactKeys(
      read,
      "libraryModuleRead.read",
      ["mode", "pageId"],
      ["query", "cursor", "limit", "includeDeleted"],
    );
    const cursor = optionalString(
      read.cursor,
      "libraryModuleRead.read.cursor",
      MAX_LIBRARY_CURSOR_LENGTH,
    );
    const limit = readLimit(read.limit, "libraryModuleRead.read.limit");
    return {
      read: {
        mode: read.mode,
        pageId: string(read.pageId, "libraryModuleRead.read.pageId", MAX_ID_LENGTH),
        ...(read.query === undefined
          ? {}
          : { query: string(read.query, "libraryModuleRead.read.query", 1_024) }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
        ...(read.includeDeleted === undefined
          ? {}
          : {
              includeDeleted: boolean(read.includeDeleted, "libraryModuleRead.read.includeDeleted"),
            }),
      },
    };
  }
  if (read.mode === "page_file_metadata") {
    exactKeys(read, "libraryModuleRead.read", ["mode", "pageId", "fileId"]);
    return {
      read: {
        mode: read.mode,
        pageId: string(read.pageId, "libraryModuleRead.read.pageId", MAX_ID_LENGTH),
        fileId: string(read.fileId, "libraryModuleRead.read.fileId", MAX_ID_LENGTH),
      },
    };
  }
  if (read.mode === "page_file_versions") {
    exactKeys(read, "libraryModuleRead.read", ["mode", "pageId", "fileId"], ["cursor", "limit"]);
    const cursor = optionalString(
      read.cursor,
      "libraryModuleRead.read.cursor",
      MAX_LIBRARY_CURSOR_LENGTH,
    );
    const limit = readLimit(read.limit, "libraryModuleRead.read.limit");
    return {
      read: {
        mode: read.mode,
        pageId: string(read.pageId, "libraryModuleRead.read.pageId", MAX_ID_LENGTH),
        fileId: string(read.fileId, "libraryModuleRead.read.fileId", MAX_ID_LENGTH),
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      },
    };
  }
  throw new TypeError("libraryModuleRead.read.mode is unsupported");
};

const parseViewLayout = (value: unknown, label: string): DatabaseViewLayout => {
  if (value === "board" || value === "list") {
    return value;
  }
  throw new TypeError(`${label} is unsupported`);
};

const parseNavigationNode = (value: unknown, label: string): LibraryNavigationNode => {
  const node = record(value, label);
  if (node.kind === "page") {
    exactKeys(node, label, [
      "kind",
      "pageId",
      "title",
      "hasChildren",
      "parentRevision",
      "metadataRevision",
      "documentGeneration",
      "documentHeadSeq",
      "updatedAt",
    ]);
    return {
      kind: "page",
      pageId: string(node.pageId, `${label}.pageId`),
      title: string(node.title, `${label}.title`, MAX_TITLE_LENGTH, true),
      hasChildren: boolean(node.hasChildren, `${label}.hasChildren`),
      parentRevision: revision(node.parentRevision, `${label}.parentRevision`),
      metadataRevision: revision(node.metadataRevision, `${label}.metadataRevision`),
      documentGeneration: revision(node.documentGeneration, `${label}.documentGeneration`),
      documentHeadSeq: revision(node.documentHeadSeq, `${label}.documentHeadSeq`),
      updatedAt: string(node.updatedAt, `${label}.updatedAt`),
    };
  }
  if (node.kind === "database") {
    exactKeys(node, label, [
      "kind",
      "databaseId",
      "title",
      "defaultViewId",
      "hasMultipleViews",
      "metadataRevision",
      "locationRevision",
      "updatedAt",
    ]);
    return {
      kind: "database",
      databaseId: parseDatabaseId(node.databaseId),
      title: string(node.title, `${label}.title`, 256),
      defaultViewId: parseDatabaseViewId(node.defaultViewId),
      hasMultipleViews: boolean(node.hasMultipleViews, `${label}.hasMultipleViews`),
      metadataRevision: revision(node.metadataRevision, `${label}.metadataRevision`),
      locationRevision: revision(node.locationRevision, `${label}.locationRevision`),
      updatedAt: string(node.updatedAt, `${label}.updatedAt`),
    };
  }
  if (node.kind === "canvas") {
    exactKeys(node, label, [
      "kind",
      "canvasId",
      "title",
      "isPrimary",
      "metadataRevision",
      "locationRevision",
      "documentGeneration",
      "documentHeadSeq",
      "updatedAt",
    ]);
    return {
      kind: "canvas",
      canvasId: existingCanvasBlockId(node.canvasId, `${label}.canvasId`),
      title: string(node.title, `${label}.title`, 256),
      isPrimary: boolean(node.isPrimary, `${label}.isPrimary`),
      metadataRevision: revision(node.metadataRevision, `${label}.metadataRevision`),
      locationRevision: revision(node.locationRevision, `${label}.locationRevision`),
      documentGeneration: revision(node.documentGeneration, `${label}.documentGeneration`),
      documentHeadSeq: revision(node.documentHeadSeq, `${label}.documentHeadSeq`),
      updatedAt: string(node.updatedAt, `${label}.updatedAt`),
    };
  }
  if (node.kind === "view") {
    exactKeys(node, label, [
      "kind",
      "viewId",
      "databaseId",
      "dataSourceId",
      "title",
      "defaultLayout",
      "isDefault",
      "revision",
    ]);
    return {
      kind: "view",
      viewId: parseDatabaseViewId(node.viewId),
      databaseId: parseDatabaseId(node.databaseId),
      dataSourceId: parseDataSourceId(node.dataSourceId),
      title: string(node.title, `${label}.title`, 256),
      defaultLayout: parseViewLayout(node.defaultLayout, `${label}.defaultLayout`),
      isDefault: boolean(node.isDefault, `${label}.isDefault`),
      revision: revision(node.revision, `${label}.revision`),
    };
  }
  throw new TypeError(`${label}.kind is unsupported`);
};

const parseCatalogEntry = (value: unknown, label: string): LibraryCatalogEntry => {
  const entry = record(value, label);
  exactKeys(entry, label, [
    "target",
    "title",
    "kind",
    "lifecycle",
    "locationLabel",
    "updatedAt",
    "locationRevision",
    "metadataRevision",
  ]);
  const target = parseRouteTarget(entry.target, `${label}.target`);
  if (target.kind === "view") {
    throw new TypeError(`${label}.target must identify a Library resource`);
  }
  if (entry.kind !== "page" && entry.kind !== "database" && entry.kind !== "canvas") {
    throw new TypeError(`${label}.kind is unsupported`);
  }
  if (target.kind !== entry.kind) {
    throw new TypeError(`${label}.target kind must match entry kind`);
  }
  if (entry.lifecycle !== "active" && entry.lifecycle !== "archived") {
    throw new TypeError(`${label}.lifecycle is unsupported`);
  }
  return {
    target,
    title: string(entry.title, `${label}.title`, MAX_TITLE_LENGTH, true),
    kind: entry.kind,
    lifecycle: entry.lifecycle,
    locationLabel: string(entry.locationLabel, `${label}.locationLabel`, MAX_TITLE_LENGTH, true),
    updatedAt: string(entry.updatedAt, `${label}.updatedAt`),
    locationRevision: revision(entry.locationRevision, `${label}.locationRevision`),
    metadataRevision: revision(entry.metadataRevision, `${label}.metadataRevision`),
  };
};

const parseMoveDestinationEntry = (value: unknown, label: string): LibraryMoveDestinationEntry => {
  const entry = record(value, label);
  exactKeys(entry, label, [
    "pageId",
    "title",
    "path",
    "hasChildren",
    "isCurrent",
    "documentGeneration",
    "documentHeadSeq",
    "updatedAt",
  ]);
  if (!Array.isArray(entry.path)) {
    throw new TypeError(`${label}.path must be an array`);
  }
  const documentGeneration = revision(entry.documentGeneration, `${label}.documentGeneration`);
  if (documentGeneration < 1) {
    throw new TypeError(`${label}.documentGeneration must be positive`);
  }
  return {
    pageId: string(entry.pageId, `${label}.pageId`),
    title: string(entry.title, `${label}.title`, MAX_TITLE_LENGTH, true),
    path: entry.path.map((part, index) =>
      string(part, `${label}.path[${index}]`, MAX_TITLE_LENGTH, true),
    ),
    hasChildren: boolean(entry.hasChildren, `${label}.hasChildren`),
    isCurrent: boolean(entry.isCurrent, `${label}.isCurrent`),
    documentGeneration,
    documentHeadSeq: revision(entry.documentHeadSeq, `${label}.documentHeadSeq`),
    updatedAt: string(entry.updatedAt, `${label}.updatedAt`),
  };
};

const parseCanvasTarget = (value: unknown, label: string): LibraryCanvasTarget => {
  const target = record(value, label);
  if (target.status === "missing") {
    exactKeys(target, label, ["status", "canvasId"]);
    return {
      status: target.status,
      canvasId: existingCanvasBlockId(target.canvasId, `${label}.canvasId`),
    };
  }
  if (target.status === "deleted") {
    exactKeys(target, label, ["status", "canvasId", "libraryId"]);
    return {
      status: target.status,
      canvasId: existingCanvasBlockId(target.canvasId, `${label}.canvasId`),
      libraryId: string(target.libraryId, `${label}.libraryId`),
    };
  }
  if (target.status !== "available") {
    throw new TypeError(`${label}.status is unsupported`);
  }
  exactKeys(target, label, ["status", "summary"]);
  const summary = record(target.summary, `${label}.summary`);
  exactKeys(summary, `${label}.summary`, [
    "canvasId",
    "projectId",
    "title",
    "lifecycle",
    "isPrimary",
    "location",
    "metadataRevision",
    "locationRevision",
    "documentGeneration",
    "documentHeadSeq",
    "updatedAt",
  ]);
  const location = record(summary.location, `${label}.summary.location`);
  const parsedLocation = (() => {
    if (location.kind === "library") {
      exactKeys(location, `${label}.summary.location`, ["kind"]);
      return { kind: "library" as const };
    }
    if (location.kind === "page") {
      exactKeys(location, `${label}.summary.location`, ["kind", "pageId", "documentId"]);
      return {
        kind: "page" as const,
        pageId: uuidV7(location.pageId, `${label}.summary.location.pageId`),
        documentId: string(location.documentId, `${label}.summary.location.documentId`),
      };
    }
    throw new TypeError(`${label}.summary.location.kind is unsupported`);
  })();
  return {
    status: target.status,
    summary: {
      canvasId: existingCanvasBlockId(summary.canvasId, `${label}.summary.canvasId`),
      title: string(summary.title, `${label}.summary.title`, 256),
      lifecycle: string(summary.lifecycle, `${label}.summary.lifecycle`, 64),
      isPrimary: boolean(summary.isPrimary, `${label}.summary.isPrimary`),
      location: parsedLocation,
      metadataRevision: revision(summary.metadataRevision, `${label}.summary.metadataRevision`),
      locationRevision: revision(summary.locationRevision, `${label}.summary.locationRevision`),
      documentGeneration: revision(
        summary.documentGeneration,
        `${label}.summary.documentGeneration`,
      ),
      documentHeadSeq: revision(summary.documentHeadSeq, `${label}.summary.documentHeadSeq`),
      updatedAt: string(summary.updatedAt, `${label}.summary.updatedAt`),
    },
  };
};

const parseLibraryAccess = (value: unknown, label: string): "read" | "read_write" => {
  if (value === "read" || value === "read_write") return value;
  throw new TypeError(`${label} is unsupported`);
};

const parseProjectAppearance = (value: unknown, label: string): ProjectAppearance => {
  const appearance = record(value, label);
  exactKeys(appearance, label, ["color", "marker"]);
  if (
    typeof appearance.color !== "string" ||
    !PROJECT_MARKER_COLORS.includes(appearance.color as (typeof PROJECT_MARKER_COLORS)[number])
  ) {
    throw new TypeError(`${label}.color is unsupported`);
  }
  const color = appearance.color as ProjectAppearance["color"];
  const marker = record(appearance.marker, `${label}.marker`);
  if (marker.kind === "icon") {
    exactKeys(marker, `${label}.marker`, ["kind", "icon"]);
    if (
      typeof marker.icon !== "string" ||
      !PROJECT_MARKER_ICONS.includes(marker.icon as (typeof PROJECT_MARKER_ICONS)[number])
    ) {
      throw new TypeError(`${label}.marker.icon is unsupported`);
    }
    return {
      color,
      marker: {
        kind: "icon",
        icon: marker.icon as Extract<ProjectAppearance["marker"], { kind: "icon" }>["icon"],
      },
    };
  }
  if (marker.kind === "emoji") {
    exactKeys(marker, `${label}.marker`, ["kind", "emoji"]);
    return {
      color,
      marker: {
        kind: "emoji",
        emoji: string(marker.emoji, `${label}.marker.emoji`, 256),
      },
    };
  }
  throw new TypeError(`${label}.marker.kind is unsupported`);
};

const parseProjectAccessRow = (
  value: unknown,
  label: string,
): Extract<LibraryReadValue, { kind: "resource_project_access" }>["value"]["projects"][number] => {
  const project = record(value, label);
  exactKeys(project, label, [
    "projectId",
    "projectName",
    "appearance",
    "lifecycle",
    "directGrant",
    "inheritedSources",
    "effectiveAccess",
  ]);
  if (
    project.lifecycle !== "active" &&
    project.lifecycle !== "inactive" &&
    project.lifecycle !== "archived"
  ) {
    throw new TypeError(`${label}.lifecycle is unsupported`);
  }
  const directGrant =
    project.directGrant === null
      ? null
      : (() => {
          const grant = record(project.directGrant, `${label}.directGrant`);
          exactKeys(grant, `${label}.directGrant`, ["access", "revision"]);
          const grantRevision = revision(grant.revision, `${label}.directGrant.revision`);
          if (grantRevision < 1) {
            throw new TypeError(`${label}.directGrant.revision must be positive`);
          }
          return {
            access: parseLibraryAccess(grant.access, `${label}.directGrant.access`),
            revision: grantRevision,
          };
        })();
  if (!Array.isArray(project.inheritedSources)) {
    throw new TypeError(`${label}.inheritedSources must be an array`);
  }
  const inheritedSources = project.inheritedSources.map((value, index) => {
    const sourceLabel = `${label}.inheritedSources[${index}]`;
    const source = record(value, sourceLabel);
    if (source.kind === "ancestor_page") {
      exactKeys(source, sourceLabel, ["kind", "pageId", "pageTitle", "access"]);
      return {
        kind: source.kind,
        pageId: string(source.pageId, `${sourceLabel}.pageId`),
        pageTitle: string(source.pageTitle, `${sourceLabel}.pageTitle`, MAX_TITLE_LENGTH, true),
        access: parseLibraryAccess(source.access, `${sourceLabel}.access`),
      } as const;
    }
    if (source.kind === "primary_database" || source.kind === "database_grant") {
      exactKeys(source, sourceLabel, ["kind", "databaseId", "databaseName", "access"]);
      return {
        kind: source.kind,
        databaseId: parseDatabaseId(source.databaseId),
        databaseName: string(source.databaseName, `${sourceLabel}.databaseName`, MAX_TITLE_LENGTH),
        access: parseLibraryAccess(source.access, `${sourceLabel}.access`),
      } as const;
    }
    throw new TypeError(`${sourceLabel}.kind is unsupported`);
  });
  const effectiveAccess =
    project.effectiveAccess === null
      ? null
      : parseLibraryAccess(project.effectiveAccess, `${label}.effectiveAccess`);
  return {
    projectId: string(project.projectId, `${label}.projectId`),
    projectName: string(project.projectName, `${label}.projectName`, MAX_TITLE_LENGTH),
    appearance: parseProjectAppearance(project.appearance, `${label}.appearance`),
    lifecycle: project.lifecycle,
    directGrant,
    inheritedSources,
    effectiveAccess,
  };
};

const parsePageFileSummary = (value: unknown, label: string) => {
  const file = record(value, label);
  exactKeys(file, label, [
    "fileId",
    "ownerPageId",
    "logicalPath",
    "mimeType",
    "byteLength",
    "version",
    "blobEtag",
    "state",
    "createdByActorId",
    "createdByTurnId",
    "createdAt",
    "updatedAt",
    "bodyUsage",
  ]);
  if (file.state !== "live" && file.state !== "deleted") {
    throw new TypeError(`${label}.state is unsupported`);
  }
  const bodyUsage = record(file.bodyUsage, `${label}.bodyUsage`);
  if (bodyUsage.kind === "not_in_body") {
    exactKeys(bodyUsage, `${label}.bodyUsage`, ["kind"]);
  } else if (bodyUsage.kind === "placed") {
    exactKeys(bodyUsage, `${label}.bodyUsage`, ["kind", "placementCount"]);
    if (revision(bodyUsage.placementCount, `${label}.bodyUsage.placementCount`) < 1) {
      throw new TypeError(`${label}.bodyUsage.placementCount must be positive`);
    }
  } else {
    throw new TypeError(`${label}.bodyUsage.kind is unsupported`);
  }
  const parsedBodyUsage: LibraryPageFileBodyUsage =
    bodyUsage.kind === "placed"
      ? {
          kind: "placed",
          placementCount: revision(bodyUsage.placementCount, `${label}.bodyUsage.placementCount`),
        }
      : { kind: "not_in_body" };
  return {
    fileId: string(file.fileId, `${label}.fileId`, MAX_ID_LENGTH),
    ownerPageId: string(file.ownerPageId, `${label}.ownerPageId`, MAX_ID_LENGTH),
    logicalPath: string(file.logicalPath, `${label}.logicalPath`, 1_024),
    mimeType: string(file.mimeType, `${label}.mimeType`, 255),
    byteLength: revision(file.byteLength, `${label}.byteLength`),
    version: revision(file.version, `${label}.version`),
    blobEtag: string(file.blobEtag, `${label}.blobEtag`, 128),
    state: file.state,
    createdByActorId: string(file.createdByActorId, `${label}.createdByActorId`, MAX_ID_LENGTH),
    createdByTurnId:
      file.createdByTurnId === null
        ? null
        : string(file.createdByTurnId, `${label}.createdByTurnId`, MAX_ID_LENGTH),
    createdAt: string(file.createdAt, `${label}.createdAt`),
    updatedAt: string(file.updatedAt, `${label}.updatedAt`),
    bodyUsage: parsedBodyUsage,
  } as const;
};

const parsePageFileOwnershipMove = (
  value: unknown,
  label: string,
): LibraryPageFileOwnershipMove => {
  const move = record(value, label);
  exactKeys(move, label, [
    "fileId",
    "previousOwnerPageId",
    "ownerPageId",
    "previousLogicalPath",
    "logicalPath",
    "version",
  ]);
  return {
    fileId: string(move.fileId, `${label}.fileId`, MAX_ID_LENGTH),
    previousOwnerPageId: string(
      move.previousOwnerPageId,
      `${label}.previousOwnerPageId`,
      MAX_ID_LENGTH,
    ),
    ownerPageId: string(move.ownerPageId, `${label}.ownerPageId`, MAX_ID_LENGTH),
    previousLogicalPath: string(move.previousLogicalPath, `${label}.previousLogicalPath`, 1_024),
    logicalPath: string(move.logicalPath, `${label}.logicalPath`, 1_024),
    version: revision(move.version, `${label}.version`),
  };
};

const parseReadValue = (value: unknown): LibraryReadValue => {
  const readValue = record(value, "libraryModuleReadResult.value.value");
  if (readValue.kind === "metadata") {
    exactKeys(readValue, "libraryModuleReadResult.value.value", ["kind"]);
    return { kind: "metadata" };
  }
  if (readValue.kind === "resource_project_access") {
    exactKeys(readValue, "libraryModuleReadResult.value.value", ["kind", "value"]);
    const accessValue = record(readValue.value, "libraryModuleReadResult.value.value.value");
    exactKeys(accessValue, "libraryModuleReadResult.value.value.value", ["target", "projects"]);
    if (!Array.isArray(accessValue.projects)) {
      throw new TypeError("library resource Project access must be an array");
    }
    return {
      kind: readValue.kind,
      value: {
        target: parseApplyResourceTarget(
          accessValue.target,
          "libraryModuleReadResult.value.value.value.target",
        ),
        projects: accessValue.projects.map((project, index) =>
          parseProjectAccessRow(project, `library resource Project access[${index}]`),
        ),
      },
    };
  }
  if (readValue.kind === "canvas_target") {
    exactKeys(readValue, "libraryModuleReadResult.value.value", ["kind", "value"]);
    return {
      kind: readValue.kind,
      value: parseCanvasTarget(readValue.value, "libraryModuleReadResult.value.value.value"),
    };
  }
  if (readValue.kind === "children") {
    exactKeys(readValue, "libraryModuleReadResult.value.value", [
      "kind",
      "parent",
      "items",
      "nextCursor",
      "hasMore",
      "total",
    ]);
    if (!Array.isArray(readValue.items)) {
      throw new TypeError("library children items must be an array");
    }
    const nextCursor =
      readValue.nextCursor === null
        ? null
        : string(
            readValue.nextCursor,
            "libraryModuleReadResult.value.value.nextCursor",
            MAX_LIBRARY_CURSOR_LENGTH,
          );
    return {
      kind: "children",
      parent: parseNavigationParent(readValue.parent, "libraryModuleReadResult.value.value.parent"),
      items: readValue.items.map((entry, index) =>
        parseNavigationNode(entry, `library children items[${index}]`),
      ),
      nextCursor,
      hasMore: boolean(readValue.hasMore, "library children hasMore"),
      total: revision(readValue.total, "library children total"),
    };
  }
  if (readValue.kind === "standalone_roots") {
    exactKeys(readValue, "libraryModuleReadResult.value.value", [
      "kind",
      "items",
      "nextCursor",
      "hasMore",
      "total",
    ]);
    if (!Array.isArray(readValue.items)) {
      throw new TypeError("library standalone roots items must be an array");
    }
    const items = readValue.items.map((entry, index) =>
      parseNavigationNode(entry, `library standalone roots items[${index}]`),
    );
    if (items.some((item) => item.kind === "view")) {
      throw new TypeError("library standalone roots cannot contain Views");
    }
    const nextCursor =
      readValue.nextCursor === null
        ? null
        : string(
            readValue.nextCursor,
            "libraryModuleReadResult.value.value.nextCursor",
            MAX_LIBRARY_CURSOR_LENGTH,
          );
    return {
      kind: "standalone_roots",
      items: items as Extract<LibraryReadValue, { kind: "standalone_roots" }>["items"],
      nextCursor,
      hasMore: boolean(readValue.hasMore, "library standalone roots hasMore"),
      total: revision(readValue.total, "library standalone roots total"),
    };
  }
  if (readValue.kind === "path") {
    exactKeys(readValue, "libraryModuleReadResult.value.value", ["kind", "target", "nodes"]);
    if (!Array.isArray(readValue.nodes)) {
      throw new TypeError("library path nodes must be an array");
    }
    return {
      kind: "path",
      target: parseRouteTarget(readValue.target, "libraryModuleReadResult.value.value.target"),
      nodes: readValue.nodes.map((entry, index) =>
        parseNavigationNode(entry, `library path nodes[${index}]`),
      ),
    };
  }
  if (readValue.kind === "catalog") {
    exactKeys(readValue, "libraryModuleReadResult.value.value", [
      "kind",
      "items",
      "nextCursor",
      "hasMore",
      "total",
    ]);
    if (!Array.isArray(readValue.items)) {
      throw new TypeError("library catalog items must be an array");
    }
    const nextCursor =
      readValue.nextCursor === null
        ? null
        : string(
            readValue.nextCursor,
            "libraryModuleReadResult.value.value.nextCursor",
            MAX_LIBRARY_CURSOR_LENGTH,
          );
    return {
      kind: "catalog",
      items: readValue.items.map((entry, index) =>
        parseCatalogEntry(entry, `library catalog items[${index}]`),
      ),
      nextCursor,
      hasMore: boolean(readValue.hasMore, "library catalog hasMore"),
      total: revision(readValue.total, "library catalog total"),
    };
  }
  if (readValue.kind === "move_destinations") {
    exactKeys(readValue, "libraryModuleReadResult.value.value", [
      "kind",
      "target",
      "scope",
      "items",
      "currentDestination",
      "nextCursor",
      "hasMore",
      "total",
      "rootIsCurrent",
    ]);
    if (!Array.isArray(readValue.items)) {
      throw new TypeError("library move destination items must be an array");
    }
    const nextCursor =
      readValue.nextCursor === null
        ? null
        : string(
            readValue.nextCursor,
            "libraryModuleReadResult.value.value.nextCursor",
            MAX_LIBRARY_CURSOR_LENGTH,
          );
    return {
      kind: "move_destinations",
      target: parseApplyResourceTarget(
        readValue.target,
        "libraryModuleReadResult.value.value.target",
      ),
      scope: parseMoveDestinationScope(
        readValue.scope,
        "libraryModuleReadResult.value.value.scope",
      ),
      items: readValue.items.map((entry, index) =>
        parseMoveDestinationEntry(entry, `library move destination items[${index}]`),
      ),
      currentDestination:
        readValue.currentDestination === null
          ? null
          : parseMoveDestinationEntry(
              readValue.currentDestination,
              "library move current destination",
            ),
      nextCursor,
      hasMore: boolean(readValue.hasMore, "library move destinations hasMore"),
      total: revision(readValue.total, "library move destinations total"),
      rootIsCurrent: boolean(readValue.rootIsCurrent, "library move destinations rootIsCurrent"),
    };
  }
  if (readValue.kind === "page_mention_destination") {
    exactKeys(readValue, "libraryModuleReadResult.value.value", ["kind", "value"]);
    const value = record(readValue.value, "library Page mention destination");
    exactKeys(value, "library Page mention destination", [
      "pageId",
      "documentId",
      "documentGeneration",
      "documentHeadSeq",
    ]);
    return {
      kind: readValue.kind,
      value: {
        pageId: uuidV7(value.pageId, "library Page mention destination.pageId"),
        documentId: string(value.documentId, "library Page mention destination.documentId"),
        documentGeneration: revision(
          value.documentGeneration,
          "library Page mention destination.documentGeneration",
        ),
        documentHeadSeq: revision(
          value.documentHeadSeq,
          "library Page mention destination.documentHeadSeq",
        ),
      },
    };
  }
  if (readValue.kind === "page_reference_candidates") {
    exactKeys(readValue, "libraryModuleReadResult.value.value", ["kind", "items"]);
    if (!Array.isArray(readValue.items)) {
      throw new TypeError("library Page reference candidates must be an array");
    }
    const items: LibraryPageReferenceCandidate[] = readValue.items.map((entry, index) => {
      const candidate = record(entry, `library Page reference candidates[${index}]`);
      exactKeys(candidate, `library Page reference candidates[${index}]`, [
        "pageId",
        "title",
        "pageKey",
        "status",
        "locationLabel",
        "matchExcerpt",
        "matchSource",
        "titleParts",
        "matchExcerptParts",
        "matches",
      ]);
      if (candidate.status !== null && !isWorkflowStatus(candidate.status)) {
        throw new TypeError(`library Page reference candidates[${index}].status is unsupported`);
      }
      if (
        candidate.matchSource !== "recent" &&
        candidate.matchSource !== "page_key" &&
        candidate.matchSource !== "title" &&
        candidate.matchSource !== "content"
      ) {
        throw new TypeError(
          `library Page reference candidates[${index}].matchSource is unsupported`,
        );
      }
      return {
        pageId: string(candidate.pageId, `library Page reference candidates[${index}].pageId`),
        title: string(
          candidate.title,
          `library Page reference candidates[${index}].title`,
          MAX_TITLE_LENGTH,
          true,
        ),
        pageKey:
          candidate.pageKey === null
            ? null
            : string(candidate.pageKey, `library Page reference candidates[${index}].pageKey`),
        status: candidate.status,
        locationLabel: string(
          candidate.locationLabel,
          `library Page reference candidates[${index}].locationLabel`,
          MAX_TITLE_LENGTH,
          true,
        ),
        matchExcerpt:
          candidate.matchExcerpt === null
            ? null
            : string(
                candidate.matchExcerpt,
                `library Page reference candidates[${index}].matchExcerpt`,
                MAX_TITLE_LENGTH,
                true,
              ),
        matchSource: candidate.matchSource,
        titleParts: parsePageSearchParts(
          candidate.titleParts,
          `library Page reference candidates[${index}].titleParts`,
        ),
        matchExcerptParts: parsePageSearchParts(
          candidate.matchExcerptParts,
          `library Page reference candidates[${index}].matchExcerptParts`,
        ),
        matches: (() => {
          if (!Array.isArray(candidate.matches)) {
            throw new TypeError(
              `library Page reference candidates[${index}].matches must be an array`,
            );
          }
          return candidate.matches.map((match, matchIndex) =>
            parsePageSearchMatch(
              match,
              `library Page reference candidates[${index}].matches[${matchIndex}]`,
            ),
          );
        })(),
      };
    });
    return { kind: readValue.kind, items };
  }
  if (readValue.kind === "page_files") {
    exactKeys(readValue, "libraryModuleReadResult.value.value", ["kind", "value"]);
    const manifest = record(readValue.value, "library Page Files manifest");
    exactKeys(manifest, "library Page Files manifest", [
      "pageId",
      "revision",
      "bodyUsageRevision",
      "files",
      "nextCursor",
      "hasMore",
      "total",
      "liveTotal",
      "unplacedTotal",
      "placedTotal",
      "deletedTotal",
    ]);
    if (!Array.isArray(manifest.files)) {
      throw new TypeError("library Page Files manifest.files must be an array");
    }
    return {
      kind: readValue.kind,
      value: {
        pageId: string(manifest.pageId, "library Page Files manifest.pageId", MAX_ID_LENGTH),
        revision: revision(manifest.revision, "library Page Files manifest.revision"),
        bodyUsageRevision: revision(
          manifest.bodyUsageRevision,
          "library Page Files manifest.bodyUsageRevision",
        ),
        files: manifest.files.map((file, index) =>
          parsePageFileSummary(file, `library Page Files manifest.files[${index}]`),
        ),
        nextCursor:
          manifest.nextCursor === null
            ? null
            : string(
                manifest.nextCursor,
                "library Page Files manifest.nextCursor",
                MAX_LIBRARY_CURSOR_LENGTH,
              ),
        hasMore: boolean(manifest.hasMore, "library Page Files manifest.hasMore"),
        total: revision(manifest.total, "library Page Files manifest.total"),
        liveTotal: revision(manifest.liveTotal, "library Page Files manifest.liveTotal"),
        unplacedTotal: revision(
          manifest.unplacedTotal,
          "library Page Files manifest.unplacedTotal",
        ),
        placedTotal: revision(manifest.placedTotal, "library Page Files manifest.placedTotal"),
        deletedTotal: revision(manifest.deletedTotal, "library Page Files manifest.deletedTotal"),
      },
    };
  }
  if (readValue.kind === "page_file_metadata") {
    exactKeys(readValue, "libraryModuleReadResult.value.value", ["kind", "value"]);
    return {
      kind: readValue.kind,
      value: parsePageFileSummary(readValue.value, "library Page File metadata"),
    };
  }
  if (readValue.kind === "page_file_versions") {
    exactKeys(readValue, "libraryModuleReadResult.value.value", ["kind", "value"]);
    const page = record(readValue.value, "library Page File versions");
    exactKeys(page, "library Page File versions", [
      "pageId",
      "fileId",
      "versions",
      "nextCursor",
      "hasMore",
    ]);
    if (!Array.isArray(page.versions)) {
      throw new TypeError("library Page File versions.versions must be an array");
    }
    const versions = page.versions.map((candidate, index) => {
      const label = `library Page File versions.versions[${index}]`;
      const version = record(candidate, label);
      exactKeys(version, label, [
        "fileId",
        "version",
        "ownerPageId",
        "manifestRevision",
        "changeKind",
        "logicalPath",
        "mimeType",
        "byteLength",
        "blobEtag",
        "actorId",
        "turnId",
        "operationId",
        "occurredAt",
      ]);
      if (
        version.changeKind !== "create" &&
        version.changeKind !== "replace" &&
        version.changeKind !== "rename" &&
        version.changeKind !== "delete" &&
        version.changeKind !== "restore" &&
        version.changeKind !== "clone" &&
        version.changeKind !== "rehome"
      ) {
        throw new TypeError(`${label}.changeKind is unsupported`);
      }
      return {
        fileId: string(version.fileId, `${label}.fileId`, MAX_ID_LENGTH),
        version: revision(version.version, `${label}.version`),
        ownerPageId: string(version.ownerPageId, `${label}.ownerPageId`, MAX_ID_LENGTH),
        manifestRevision: revision(version.manifestRevision, `${label}.manifestRevision`),
        changeKind: version.changeKind,
        logicalPath: string(version.logicalPath, `${label}.logicalPath`, 1_024),
        mimeType: string(version.mimeType, `${label}.mimeType`, 255),
        byteLength: revision(version.byteLength, `${label}.byteLength`),
        blobEtag:
          version.blobEtag === null ? null : string(version.blobEtag, `${label}.blobEtag`, 128),
        actorId: string(version.actorId, `${label}.actorId`, MAX_ID_LENGTH),
        turnId:
          version.turnId === null ? null : string(version.turnId, `${label}.turnId`, MAX_ID_LENGTH),
        operationId: string(version.operationId, `${label}.operationId`, MAX_ID_LENGTH),
        occurredAt: string(version.occurredAt, `${label}.occurredAt`),
      } as const;
    });
    return {
      kind: readValue.kind,
      value: {
        pageId: string(page.pageId, "library Page File versions.pageId", MAX_ID_LENGTH),
        fileId: string(page.fileId, "library Page File versions.fileId", MAX_ID_LENGTH),
        versions,
        nextCursor:
          page.nextCursor === null
            ? null
            : string(
                page.nextCursor,
                "library Page File versions.nextCursor",
                MAX_LIBRARY_CURSOR_LENGTH,
              ),
        hasMore: boolean(page.hasMore, "library Page File versions.hasMore"),
      },
    };
  }
  throw new TypeError("libraryModuleReadResult value kind is unsupported");
};

const parseErrorCode = (value: unknown): LibraryModuleErrorCode => {
  if (
    value === "invalid_request" ||
    value === "store_epoch_mismatch" ||
    value === "identity_conflict" ||
    value === "resource_not_found" ||
    value === "revision_conflict" ||
    value === "invalid_parent" ||
    value === "hierarchy_cycle" ||
    value === "project_inactive" ||
    value === "primary_database_bound" ||
    value === "document_conflict" ||
    value === "stale_cursor" ||
    value === "resource_exhausted" ||
    value === "file_in_use" ||
    value === "state_corrupt" ||
    value === "unknown"
  ) {
    return value;
  }
  throw new TypeError("libraryModuleReadResult.error.code is unsupported");
};

export const parseLibraryModuleReadResult = (value: unknown): LibraryModuleReadResult => {
  const result = record(value, "libraryModuleReadResult");
  if (result.ok === false) {
    exactKeys(result, "libraryModuleReadResult", ["ok", "error"]);
    const error = record(result.error, "libraryModuleReadResult.error");
    exactKeys(error, "libraryModuleReadResult.error", ["code", "message", "retryable"]);
    return {
      ok: false,
      error: {
        code: parseErrorCode(error.code),
        message: string(error.message, "libraryModuleReadResult.error.message", 4096),
        retryable: boolean(error.retryable, "libraryModuleReadResult.error.retryable"),
      },
    };
  }
  if (result.ok !== true) {
    throw new TypeError("libraryModuleReadResult.ok must be a boolean");
  }
  exactKeys(result, "libraryModuleReadResult", ["ok", "value"]);
  const snapshot = record(result.value, "libraryModuleReadResult.value");
  exactKeys(snapshot, "libraryModuleReadResult.value", [
    "profileId",
    "libraryId",
    "storeEpoch",
    "commitSeq",
    "authorization",
    "value",
  ]);
  return {
    ok: true,
    value: {
      profileId: string(snapshot.profileId, "libraryModuleReadResult.value.profileId"),
      libraryId: string(snapshot.libraryId, "libraryModuleReadResult.value.libraryId"),
      storeEpoch: string(snapshot.storeEpoch, "libraryModuleReadResult.value.storeEpoch"),
      commitSeq: revision(snapshot.commitSeq, "libraryModuleReadResult.value.commitSeq"),
      authorization:
        snapshot.authorization === null ? null : parseAuthorizedReadStamp(snapshot.authorization),
      value: parseReadValue(snapshot.value),
    },
  };
};

const parseDocumentCommitRef = (value: unknown, label: string) => {
  const commit = record(value, label);
  exactKeys(commit, label, [
    "documentId",
    "generation",
    "baseHeadSeq",
    "headSeq",
    "updateId",
    "update",
    "stateVector",
  ]);
  return {
    documentId: string(commit.documentId, `${label}.documentId`),
    generation: revision(commit.generation, `${label}.generation`),
    baseHeadSeq: revision(commit.baseHeadSeq, `${label}.baseHeadSeq`),
    headSeq: revision(commit.headSeq, `${label}.headSeq`),
    updateId: string(commit.updateId, `${label}.updateId`),
    update: commit.update === null ? null : bytes(commit.update, `${label}.update`),
    stateVector: bytes(commit.stateVector, `${label}.stateVector`),
  };
};

const parseStringMap = (value: unknown, label: string): Readonly<Record<string, string>> => {
  const source = record(value, label);
  if (Object.keys(source).length > MAX_STRUCTURAL_ROOTS) {
    throw new TypeError(`${label} exceeds the structural edit limit`);
  }
  return Object.fromEntries(
    Object.entries(source).map(([key, candidate]) => [
      string(key, `${label} key`),
      string(candidate, `${label}.${key}`),
    ]),
  );
};

const parseApplyReceipt = (value: unknown): LibraryModuleApplyReceipt => {
  const receipt = record(value, "libraryModuleApplyResult.value");
  exactKeys(
    receipt,
    "libraryModuleApplyResult.value",
    [
      "operationId",
      "profileId",
      "storeEpoch",
      "libraryId",
      "operationKind",
      "duplicate",
      "didMutate",
      "createdTarget",
      "canvasMutation",
      "structuralEdit",
      "affectedParentKeys",
      "affectedPageIds",
      "affectedDatabaseIds",
      "affectedViewIds",
      "committedRevisions",
      "commitSeq",
      "committedAt",
    ],
    ["pageFiles"],
  );
  const operationKinds = new Set([
    "create_page",
    "create_database",
    "create_canvas",
    "rename_canvas",
    "move_canvas",
    "duplicate_canvas",
    "delete_canvas",
    "move_block",
    "archive_resource",
    "restore_resource",
    "grant_project_access",
    "set_project_access",
    "apply_page_metadata_properties",
    "apply_page_file_changes",
    "apply_structural_edit",
    "reverse_structural_edit",
  ]);
  if (typeof receipt.operationKind !== "string" || !operationKinds.has(receipt.operationKind)) {
    throw new TypeError("libraryModuleApplyResult.value.operationKind is unsupported");
  }
  const parseStringList = (candidate: unknown, label: string): readonly string[] => {
    if (!Array.isArray(candidate) || candidate.some((entry) => typeof entry !== "string")) {
      throw new TypeError(`${label} must be a string array`);
    }
    const values = candidate.map((entry, index) => string(entry, `${label}[${index}]`));
    if (new Set(values).size !== values.length) {
      throw new TypeError(`${label} must contain unique values`);
    }
    return values;
  };
  const rawRevisions = record(
    receipt.committedRevisions,
    "libraryModuleApplyResult.value.committedRevisions",
  );
  const committedRevisions = Object.fromEntries(
    Object.entries(rawRevisions).map(([key, candidate]) => [
      string(key, "libraryModuleApplyResult.value.committedRevisions key"),
      revision(candidate, `libraryModuleApplyResult.value.committedRevisions.${key}`),
    ]),
  );
  const rawCreatedTarget = receipt.createdTarget;
  const createdTarget =
    rawCreatedTarget === null
      ? null
      : parseRouteTarget(rawCreatedTarget, "libraryModuleApplyResult.value.createdTarget");
  if (createdTarget?.kind === "view") {
    throw new TypeError("libraryModuleApplyResult.value.createdTarget cannot be a View");
  }
  const canvasMutation = (() => {
    if (receipt.canvasMutation === null) return null;
    const mutation = record(
      receipt.canvasMutation,
      "libraryModuleApplyResult.value.canvasMutation",
    );
    exactKeys(mutation, "libraryModuleApplyResult.value.canvasMutation", [
      "operationKind",
      "canvasId",
      "documentId",
      "sourceCanvasId",
      "locationRevision",
      "metadataRevision",
      "documentCommits",
    ]);
    if (!Array.isArray(mutation.documentCommits)) {
      throw new TypeError(
        "libraryModuleApplyResult.value.canvasMutation.documentCommits must be an array",
      );
    }
    return {
      operationKind: string(
        mutation.operationKind,
        "libraryModuleApplyResult.value.canvasMutation.operationKind",
      ),
      canvasId: existingCanvasBlockId(
        mutation.canvasId,
        "libraryModuleApplyResult.value.canvasMutation.canvasId",
      ),
      documentId: existingCanvasDocumentId(
        mutation.documentId,
        "libraryModuleApplyResult.value.canvasMutation.documentId",
      ),
      sourceCanvasId:
        mutation.sourceCanvasId === null
          ? null
          : existingCanvasBlockId(
              mutation.sourceCanvasId,
              "libraryModuleApplyResult.value.canvasMutation.sourceCanvasId",
            ),
      locationRevision: revision(
        mutation.locationRevision,
        "libraryModuleApplyResult.value.canvasMutation.locationRevision",
      ),
      metadataRevision: revision(
        mutation.metadataRevision,
        "libraryModuleApplyResult.value.canvasMutation.metadataRevision",
      ),
      documentCommits: mutation.documentCommits.map((candidate, index) =>
        parseDocumentCommitRef(
          candidate,
          `libraryModuleApplyResult.value.canvasMutation.documentCommits[${index}]`,
        ),
      ),
    };
  })();
  const structuralEdit = (() => {
    if (receipt.structuralEdit === null) return null;
    const edit = record(receipt.structuralEdit, "libraryModuleApplyResult.value.structuralEdit");
    const label = "libraryModuleApplyResult.value.structuralEdit";
    exactKeys(edit, label, [
      "operationKind",
      "sourceRootBlockIds",
      "resultRootBlockIds",
      "copiedBlockIds",
      "copiedDocumentIds",
      "documentCommits",
      "affectedPageIds",
      "affectedDatabaseIds",
      "fileOwnershipMoves",
      "clipboard",
      "history",
      "supersededHistoryRecipeOperationIds",
      "resume",
    ]);
    if (!Array.isArray(edit.documentCommits)) {
      throw new TypeError(`${label}.documentCommits must be an array`);
    }
    const resume = (() => {
      if (edit.resume === null) return null;
      const target = record(edit.resume, `${label}.resume`);
      exactKeys(target, `${label}.resume`, [
        "blockId",
        "edge",
        "fallbackBeforeBlockId",
        "fallbackAfterBlockId",
      ]);
      if (target.edge !== "start" && target.edge !== "end") {
        throw new TypeError(`${label}.resume.edge is unsupported`);
      }
      return {
        blockId: string(target.blockId, `${label}.resume.blockId`),
        edge: target.edge as "start" | "end",
        fallbackBeforeBlockId:
          target.fallbackBeforeBlockId === null
            ? null
            : string(target.fallbackBeforeBlockId, `${label}.resume.fallbackBeforeBlockId`),
        fallbackAfterBlockId:
          target.fallbackAfterBlockId === null
            ? null
            : string(target.fallbackAfterBlockId, `${label}.resume.fallbackAfterBlockId`),
      };
    })();
    return {
      operationKind: string(edit.operationKind, `${label}.operationKind`),
      sourceRootBlockIds: parseStringList(edit.sourceRootBlockIds, `${label}.sourceRootBlockIds`),
      resultRootBlockIds: parseStringList(edit.resultRootBlockIds, `${label}.resultRootBlockIds`),
      copiedBlockIds: parseStringMap(edit.copiedBlockIds, `${label}.copiedBlockIds`),
      copiedDocumentIds: parseStringMap(edit.copiedDocumentIds, `${label}.copiedDocumentIds`),
      documentCommits: edit.documentCommits.map((candidate, index) =>
        parseDocumentCommitRef(candidate, `${label}.documentCommits[${index}]`),
      ),
      affectedPageIds: parseStringList(edit.affectedPageIds, `${label}.affectedPageIds`),
      affectedDatabaseIds: parseStringList(
        edit.affectedDatabaseIds,
        `${label}.affectedDatabaseIds`,
      ).map(parseDatabaseId),
      fileOwnershipMoves: (() => {
        if (!Array.isArray(edit.fileOwnershipMoves)) {
          throw new TypeError(`${label}.fileOwnershipMoves must be an array`);
        }
        return edit.fileOwnershipMoves.map((candidate, index) =>
          parsePageFileOwnershipMove(candidate, `${label}.fileOwnershipMoves[${index}]`),
        );
      })(),
      clipboard:
        edit.clipboard === null
          ? null
          : parseStructuralClipboardToken(edit.clipboard, `${label}.clipboard`),
      history:
        edit.history === null
          ? null
          : parseStructuralHistoryToken(edit.history, `${label}.history`),
      supersededHistoryRecipeOperationIds: parseStringList(
        edit.supersededHistoryRecipeOperationIds,
        `${label}.supersededHistoryRecipeOperationIds`,
      ),
      resume,
    };
  })();
  const pageFiles = (() => {
    if (receipt.pageFiles === undefined) return undefined;
    if (receipt.pageFiles === null) return null;
    const files = record(receipt.pageFiles, "libraryModuleApplyResult.value.pageFiles");
    const label = "libraryModuleApplyResult.value.pageFiles";
    exactKeys(files, label, [
      "pageId",
      "manifestRevision",
      "createdFileIds",
      "updatedFileIds",
      "deletedFileIds",
      "consumedBlobReceiptIds",
    ]);
    return {
      pageId: string(files.pageId, `${label}.pageId`, MAX_ID_LENGTH),
      manifestRevision: revision(files.manifestRevision, `${label}.manifestRevision`),
      createdFileIds: parseStringList(files.createdFileIds, `${label}.createdFileIds`),
      updatedFileIds: parseStringList(files.updatedFileIds, `${label}.updatedFileIds`),
      deletedFileIds: parseStringList(files.deletedFileIds, `${label}.deletedFileIds`),
      consumedBlobReceiptIds: parseStringList(
        files.consumedBlobReceiptIds,
        `${label}.consumedBlobReceiptIds`,
      ),
    };
  })();
  return {
    operationId: string(receipt.operationId, "libraryModuleApplyResult.value.operationId"),
    profileId: string(receipt.profileId, "libraryModuleApplyResult.value.profileId"),
    storeEpoch: string(receipt.storeEpoch, "libraryModuleApplyResult.value.storeEpoch"),
    libraryId: string(receipt.libraryId, "libraryModuleApplyResult.value.libraryId"),
    operationKind: receipt.operationKind as LibraryModuleApplyReceipt["operationKind"],
    duplicate: boolean(receipt.duplicate, "libraryModuleApplyResult.value.duplicate"),
    didMutate: boolean(receipt.didMutate, "libraryModuleApplyResult.value.didMutate"),
    createdTarget,
    canvasMutation,
    structuralEdit,
    ...(pageFiles === undefined ? {} : { pageFiles }),
    affectedParentKeys: parseStringList(
      receipt.affectedParentKeys,
      "libraryModuleApplyResult.value.affectedParentKeys",
    ),
    affectedPageIds: parseStringList(
      receipt.affectedPageIds,
      "libraryModuleApplyResult.value.affectedPageIds",
    ),
    affectedDatabaseIds: parseStringList(
      receipt.affectedDatabaseIds,
      "libraryModuleApplyResult.value.affectedDatabaseIds",
    ).map(parseDatabaseId),
    affectedViewIds: parseStringList(
      receipt.affectedViewIds,
      "libraryModuleApplyResult.value.affectedViewIds",
    ).map(parseDatabaseViewId),
    committedRevisions,
    commitSeq: revision(receipt.commitSeq, "libraryModuleApplyResult.value.commitSeq"),
    committedAt: string(receipt.committedAt, "libraryModuleApplyResult.value.committedAt"),
  };
};

export const parseLibraryModuleApplyResult = (value: unknown): LibraryModuleApplyResult => {
  const result = record(value, "libraryModuleApplyResult");
  if (result.ok === false) {
    exactKeys(result, "libraryModuleApplyResult", ["ok", "error"]);
    const error = record(result.error, "libraryModuleApplyResult.error");
    exactKeys(error, "libraryModuleApplyResult.error", ["code", "message", "retryable"]);
    return {
      ok: false,
      error: {
        code: parseErrorCode(error.code),
        message: string(error.message, "libraryModuleApplyResult.error.message", 4096),
        retryable: boolean(error.retryable, "libraryModuleApplyResult.error.retryable"),
      },
    };
  }
  if (result.ok !== true) {
    throw new TypeError("libraryModuleApplyResult.ok must be a boolean");
  }
  exactKeys(result, "libraryModuleApplyResult", ["ok", "value", "localCommit"]);
  return {
    ok: true,
    value: parseApplyReceipt(result.value),
    localCommit: parseLocalCommitApply(result.localCommit),
  };
};

export const libraryModuleFailure = (
  code: LibraryModuleErrorCode,
  message: string,
  retryable = false,
): LibraryModuleError => ({ code, message, retryable });

export const libraryModuleHttpStatus = (error: LibraryModuleError): 400 | 404 | 409 | 500 => {
  if (error.code === "invalid_request" || error.code === "resource_exhausted") return 400;
  if (error.code === "resource_not_found") return 404;
  if (
    error.code === "stale_cursor" ||
    error.code === "store_epoch_mismatch" ||
    error.code === "identity_conflict" ||
    error.code === "revision_conflict" ||
    error.code === "invalid_parent" ||
    error.code === "hierarchy_cycle" ||
    error.code === "project_inactive" ||
    error.code === "primary_database_bound" ||
    error.code === "document_conflict"
  )
    return 409;
  if (error.code === "state_corrupt") return 500;
  return 500;
};

export const resolveLibraryReadLimit = (limit: number | undefined): number =>
  limit ?? DEFAULT_LIBRARY_READ_LIMIT;
