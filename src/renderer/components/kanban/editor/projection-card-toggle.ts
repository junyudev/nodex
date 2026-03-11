import {
  blockToCardPatch,
  cardToToggleBlock,
} from "../../../lib/toggle-list/block-mapping";
import type { CardInput } from "../../../lib/types";
import type {
  ToggleListCard,
  ToggleListPropertyKey,
  ToggleListStatusId,
} from "../../../lib/toggle-list/types";
import {
  TOGGLE_LIST_STATUS_ORDER,
} from "../../../lib/toggle-list/types";
import { parseCardToggleMetaOverrides } from "./card-toggle-snapshot";

export const PROJECTION_OWNER_PROP = "projectionOwnerId";
export const PROJECTION_KIND_PROP = "projectionKind";
export const PROJECTION_SOURCE_PROJECT_PROP = "projectionSourceProjectId";
export const PROJECTION_CARD_ID_PROP = "projectionCardId";

export type ProjectionKind = "cardRef" | "toggleListInlineView";

interface RecordLike {
  [key: string]: unknown;
}

interface BlockLike {
  id?: string;
  type?: string;
  props?: RecordLike;
  content?: unknown;
  children?: unknown[];
}

export interface ProjectedCardPatch {
  cardId: string;
  sourceProjectId: string;
  updates: Partial<CardInput>;
  targetStatus?: ToggleListStatusId;
}

type ProjectedCardComparable = Pick<
ToggleListCard,
  "title" | "description" | "priority" | "estimate" | "tags" | "columnId"
>;

export interface ProjectedCardToggleBuildOptions {
  ownerBlockId: string;
  projectionKind: ProjectionKind;
  sourceProjectId: string;
  card: ToggleListCard;
  propertyOrder: ToggleListPropertyKey[];
  hiddenProperties: ToggleListPropertyKey[];
  showEmptyEstimate?: boolean;
}

let projectionMutationDepth = 0;

function sanitizeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null;
}

function asBlock(value: unknown): BlockLike | null {
  if (!isRecord(value)) return null;
  return value as BlockLike;
}

function toStringProp(props: RecordLike | undefined, key: string): string {
  const value = props?.[key];
  return typeof value === "string" ? value : "";
}

function cloneWithChildren(block: BlockLike, children: unknown[]): unknown {
  return {
    ...block,
    children,
  };
}

function isToggleListStatusId(value: string): value is ToggleListStatusId {
  return TOGGLE_LIST_STATUS_ORDER.includes(value as ToggleListStatusId);
}

function isValidTag(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasOwn<K extends string>(value: object, key: K): value is Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function getCardIdentity(block: BlockLike | null): string {
  if (!block || !isRecord(block.props)) return "";
  const cardId = toStringProp(block.props, PROJECTION_CARD_ID_PROP)
    || toStringProp(block.props, "cardId");
  const sourceProjectId = toStringProp(block.props, PROJECTION_SOURCE_PROJECT_PROP)
    || toStringProp(block.props, "sourceProjectId");
  if (!cardId || !sourceProjectId) return "";
  return `${sourceProjectId}:${cardId}`;
}

function projectedCardIdentitySet(rows: unknown[]): Set<string> {
  const identities = new Set<string>();
  for (const row of rows) {
    const identity = getCardIdentity(asBlock(row));
    if (identity) {
      identities.add(identity);
    }
  }
  return identities;
}

function isLeakedProjectedDuplicate(
  value: unknown,
  projectedIdentities: Set<string>,
): boolean {
  if (projectedIdentities.size === 0) return false;
  if (isProjectedCardToggleBlock(value)) return false;

  const block = asBlock(value);
  if (!block || block.type !== "cardToggle") return false;
  const identity = getCardIdentity(block);
  if (!identity) return false;

  return projectedIdentities.has(identity);
}

export function runWithProjectionMutation<T>(fn: () => T): T {
  projectionMutationDepth += 1;
  try {
    return fn();
  } finally {
    projectionMutationDepth = Math.max(0, projectionMutationDepth - 1);
  }
}

export function isProjectionMutationActive(): boolean {
  return projectionMutationDepth > 0;
}

export function makeProjectedCardToggleBlockId(
  ownerBlockId: string,
  sourceProjectId: string,
  cardId: string,
): string {
  const owner = sanitizeIdPart(ownerBlockId);
  const project = sanitizeIdPart(sourceProjectId);
  const card = sanitizeIdPart(cardId);
  return `projected-card-toggle-${owner}-${project}-${card}`;
}

export function isProjectedCardToggleBlock(
  block: unknown,
  ownerBlockId?: string,
): boolean {
  const maybeBlock = asBlock(block);
  if (!maybeBlock) return false;
  if (maybeBlock.type !== "cardToggle") return false;
  if (!isRecord(maybeBlock.props)) return false;

  const owner = toStringProp(maybeBlock.props, PROJECTION_OWNER_PROP);
  if (!owner) return false;
  if (!ownerBlockId) return true;
  return owner === ownerBlockId;
}

export function splitEmbedChildren(
  children: unknown[] | undefined,
  ownerBlockId: string,
): {
  projectedRows: unknown[];
  hostChildren: unknown[];
} {
  if (!Array.isArray(children) || children.length === 0) {
    return {
      projectedRows: [],
      hostChildren: [],
    };
  }

  const projectedRows: unknown[] = [];
  const hostChildren: unknown[] = [];

  for (const child of children) {
    if (isProjectedCardToggleBlock(child, ownerBlockId)) {
      projectedRows.push(child);
      continue;
    }
    hostChildren.push(child);
  }

  return {
    projectedRows,
    hostChildren,
  };
}

export function buildProjectedCardToggleBlock(
  options: ProjectedCardToggleBuildOptions,
): unknown {
  const {
    ownerBlockId,
    projectionKind,
    sourceProjectId,
    card,
    propertyOrder,
    hiddenProperties,
    showEmptyEstimate = false,
  } = options;

  const base = cardToToggleBlock(
    sourceProjectId,
    card,
    propertyOrder,
    hiddenProperties,
    undefined,
    showEmptyEstimate,
  ) as RecordLike;

  const baseProps = isRecord(base.props)
    ? base.props
    : {};

  return {
    ...base,
    id: makeProjectedCardToggleBlockId(ownerBlockId, sourceProjectId, card.id),
    props: {
      ...baseProps,
      sourceProjectId,
      sourceStatus: card.columnId,
      sourceStatusName: card.columnName,
      [PROJECTION_OWNER_PROP]: ownerBlockId,
      [PROJECTION_KIND_PROP]: projectionKind,
      [PROJECTION_SOURCE_PROJECT_PROP]: sourceProjectId,
      [PROJECTION_CARD_ID_PROP]: card.id,
    },
  };
}

export function buildProjectedChildren(
  ownerBlockId: string,
  projectedRows: unknown[],
  existingChildren: unknown[] | undefined,
): unknown[] {
  void ownerBlockId;
  void existingChildren;
  return [...projectedRows];
}

export function pickProjectedCardFieldUpdates(
  patch: ProjectedCardPatch,
  card: Pick<ProjectedCardComparable, "title" | "description" | "priority" | "estimate" | "tags">,
): Partial<CardInput> {
  const updates: Partial<CardInput> = {};
  const nextUpdates = patch.updates;

  if (typeof nextUpdates.title === "string" && nextUpdates.title !== card.title) {
    updates.title = nextUpdates.title;
  }

  if (
    typeof nextUpdates.description === "string"
    && nextUpdates.description !== (card.description ?? "")
  ) {
    updates.description = nextUpdates.description;
  }

  if (typeof nextUpdates.priority === "string" && nextUpdates.priority !== card.priority) {
    updates.priority = nextUpdates.priority;
  }

  if (hasOwn(nextUpdates, "estimate")) {
    const nextEstimate = nextUpdates.estimate ?? null;
    const currentEstimate = card.estimate ?? null;
    if (nextEstimate !== currentEstimate) {
      updates.estimate = nextEstimate;
    }
  }

  if (Array.isArray(nextUpdates.tags)) {
    const normalizedTags = nextUpdates.tags.filter(isValidTag);
    if (!areStringArraysEqual(normalizedTags, card.tags)) {
      updates.tags = normalizedTags;
    }
  }

  return updates;
}

export function isProjectedCardMoveDirty(
  patch: ProjectedCardPatch,
  card: Pick<ProjectedCardComparable, "columnId">,
): boolean {
  return Boolean(
    patch.targetStatus
    && patch.targetStatus.length > 0
    && patch.targetStatus !== card.columnId,
  );
}

export function collectProjectedCardPatchesForOwner(
  children: unknown[] | undefined,
  ownerBlockId: string,
  editorElement?: HTMLElement,
): ProjectedCardPatch[] {
  if (!Array.isArray(children) || children.length === 0) return [];

  const patches: ProjectedCardPatch[] = [];

  for (const child of children) {
    if (!isProjectedCardToggleBlock(child, ownerBlockId)) continue;
    const block = asBlock(child);
    if (!block || !isRecord(block.props)) continue;

    const cardId = toStringProp(block.props, PROJECTION_CARD_ID_PROP)
      || toStringProp(block.props, "cardId");
    const sourceProjectId = toStringProp(block.props, PROJECTION_SOURCE_PROJECT_PROP)
      || toStringProp(block.props, "sourceProjectId");
    if (!cardId || !sourceProjectId) continue;

    const normalizedChildren = Array.isArray(block.children)
      ? stripProjectedSubtrees(block.children)
      : undefined;
    const patchBlock = normalizedChildren
      ? cloneWithChildren(block, normalizedChildren)
      : block;
    const patch = blockToCardPatch(patchBlock, editorElement);
    if (!patch) continue;
    const meta = toStringProp(block.props, "meta");
    const metaOverrides = parseCardToggleMetaOverrides(meta);

    const updates: Partial<CardInput> = {
      title: patch.title,
      description: patch.description,
      ...(metaOverrides.priority ? { priority: metaOverrides.priority } : {}),
      ...(metaOverrides.hasEstimate
        ? { estimate: metaOverrides.estimate ?? null }
        : {}),
    };

    const targetStatus = metaOverrides.statusId && isToggleListStatusId(metaOverrides.statusId)
      ? metaOverrides.statusId
      : undefined;

    patches.push({
      cardId,
      sourceProjectId,
      updates,
      ...(targetStatus ? { targetStatus } : {}),
    });
  }

  return patches;
}

export function stripProjectedSubtrees(blocks: unknown[]): unknown[] {
  const stripped: unknown[] = [];
  const projectedIdentities = projectedCardIdentitySet(
    blocks.filter((block) => isProjectedCardToggleBlock(block)),
  );

  for (const blockValue of blocks) {
    if (isProjectedCardToggleBlock(blockValue)) {
      continue;
    }

    if (isLeakedProjectedDuplicate(blockValue, projectedIdentities)) {
      continue;
    }

    const block = asBlock(blockValue);
    if (!block) {
      stripped.push(blockValue);
      continue;
    }

    if (!Array.isArray(block.children) || block.children.length === 0) {
      stripped.push(blockValue);
      continue;
    }

    const nextChildren = stripProjectedSubtrees(block.children);
    stripped.push(cloneWithChildren(block, nextChildren));
  }

  return stripped;
}

export function hasRecursiveCardRefAncestor(
  editor: {
    getBlock: (id: string) => unknown;
    getParentBlock: (id: string) => unknown;
  },
  blockId: string,
  recursionKey: string,
): boolean {
  let current = editor.getParentBlock(blockId);

  while (isRecord(current) && typeof current.id === "string") {
    const currentProps = isRecord(current.props)
      ? current.props
      : undefined;

    if (current.type === "cardRef") {
      const key = `${toStringProp(currentProps, "sourceProjectId")}:${toStringProp(currentProps, "cardId")}`;
      if (key === recursionKey) return true;
    }

    if (current.type === "cardToggle") {
      const sourceProjectId = toStringProp(currentProps, PROJECTION_SOURCE_PROJECT_PROP)
        || toStringProp(currentProps, "sourceProjectId");
      const cardId = toStringProp(currentProps, PROJECTION_CARD_ID_PROP)
        || toStringProp(currentProps, "cardId");
      if (sourceProjectId && cardId && `${sourceProjectId}:${cardId}` === recursionKey) {
        return true;
      }
    }

    current = editor.getParentBlock(current.id);
  }

  return false;
}

export function hasRecursiveInlineProjectAncestor(
  editor: {
    getParentBlock: (id: string) => unknown;
  },
  blockId: string,
  sourceProjectId: string,
): boolean {
  let current = editor.getParentBlock(blockId);

  while (isRecord(current) && typeof current.id === "string") {
    if (current.type === "toggleListInlineView") {
      const props = isRecord(current.props)
        ? current.props
        : undefined;
      if (toStringProp(props, "sourceProjectId") === sourceProjectId) {
        return true;
      }
    }

    current = editor.getParentBlock(current.id);
  }

  return false;
}

export function serializeProjectionRows(rows: unknown[]): string {
  const normalizedRows = rows.map((row) => {
    const block = asBlock(row);
    if (!block || block.type !== "cardToggle") return row;

    const props = isRecord(block.props)
      ? block.props
      : undefined;

    const patch = blockToCardPatch(block);

    return {
      type: "cardToggle",
      cardId: toStringProp(props, PROJECTION_CARD_ID_PROP)
        || toStringProp(props, "cardId"),
      sourceProjectId: toStringProp(props, PROJECTION_SOURCE_PROJECT_PROP)
        || toStringProp(props, "sourceProjectId"),
      sourceStatus: toStringProp(props, "sourceStatus"),
      sourceStatusName: toStringProp(props, "sourceStatusName"),
      meta: toStringProp(props, "meta"),
      snapshot: toStringProp(props, "snapshot"),
      title: patch?.title ?? "",
      description: patch?.description ?? "",
    };
  });

  return JSON.stringify(normalizedRows);
}
