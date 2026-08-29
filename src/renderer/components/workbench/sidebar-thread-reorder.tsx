import {
  closestCenter,
  useDroppable,
  type CollisionDetection,
  type DragCancelEvent,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  type AnimateLayoutChanges,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { replaceVisibleCodexSidebarThreadKeyOrder } from "@/lib/codex-sidebar-thread-sync";
import { useCanonicalOrderHandoff } from "@/lib/use-canonical-order-handoff";
import { cn } from "@/lib/utils";
import {
  codexSidebarProjectThreadContainerId,
  isCodexSidebarPinnedThreadContainerId,
} from "../../../shared/codex-sidebar-thread-move";
import { createUuidV7 } from "../../../shared/uuid-v7";
import { readSidebarSectionContainerId } from "../../../shared/sidebar-sections";
import { SidebarDropIndicator } from "./sidebar-drop-indicator";
import {
  PINNED_PROJECT_CONTAINER_ID,
  readSidebarGroupDndPayload,
  useSidebarProjectDndState,
  type SidebarGroupDndPayload,
} from "./sidebar-project-group-dnd";

export interface SidebarThreadDropTarget {
  beforeThreadKey: string | null;
}

export type SidebarThreadProjectKind = "local" | "remote";

export type SidebarThreadProjectDropZone =
  | "project-gutter"
  | "project-icon"
  | "project-pagination"
  | "project-row";

export type SidebarThreadKind = "local" | "remote";

// The pointer already previews the final boundary. Replaying the source rect
// after release makes a committed drop look like a second, automatic move.
const disableSidebarThreadLayoutAnimation: AnimateLayoutChanges = () => false;

export interface SidebarThreadDndThread {
  containerId: string;
  dragOverlay: ReactNode;
  getNextThreadId?: () => string | null;
  getNextThreadKey?: () => string | null;
  getPreviousThreadId?: () => string | null;
  nextThreadKey?: string | null;
  sourceProjectKind?: SidebarThreadProjectKind;
  targetProjectKind?: SidebarThreadProjectKind;
  threadId: string | null;
  threadKey: string;
}

export interface SidebarThreadItemDndPayload {
  kind: "sidebar-item";
  controller: SidebarThreadReorderController;
  itemId?: string;
  itemIds?: string[];
  nextItemId?: string | null;
  thread: SidebarThreadDndThread;
}

export interface SidebarThreadContainerDndPayload {
  kind: "sidebar-thread-container";
  beforeItemId?: string | null;
  containerId: string;
  itemIds?: string[];
  preserveSourceProjectLane?: true;
  projectDropZone?: SidebarThreadProjectDropZone;
  targetProjectKind?: SidebarThreadProjectKind;
}

export interface SidebarThreadDropRequest {
  beforeItemId?: string | null;
  beforeThreadId: string | null;
  afterThreadId?: string;
  insertAtEnd?: true;
  itemId?: string;
  sourceContainerId: string;
  targetContainerId: string;
  targetItemIds?: string[];
  threadId: string;
  useDefaultOrder?: true;
}

export interface SidebarThreadDropCommit {
  operationId: string;
  projectionRevision: number;
}

export interface PendingSidebarThreadDrop {
  beforeThreadId: string | null;
  afterThreadId?: string;
  commitOperationId?: string;
  homeContainerId: string | null;
  insertAtEnd?: true;
  operationId: string;
  phase: "submitting" | "acknowledged";
  projectionRevision?: number;
  sourceContainerId: string;
  targetContainerId: string;
  threadId: string;
  threadKey: string;
  useDefaultOrder?: true;
}

export interface SidebarThreadCanonicalLane {
  projectionRevision: number | null;
  threadIds: readonly string[];
}

export type SidebarThreadCanonicalLanes = ReadonlyMap<string, SidebarThreadCanonicalLane>;

export type SidebarThreadDropPolicy =
  | { status: "allowed" }
  | {
      status: "blocked";
      reason:
        | "cloud-deferred"
        | "pending-cross-container"
        | "project-kind-mismatch"
        | "remote-deferred"
        | "reorder-only-source"
        | "unsupported-target";
    };

export interface SidebarThreadDropPolicyInput {
  homeContainerId: string | null;
  sourceContainerId: string;
  sourceProjectKind?: SidebarThreadProjectKind;
  targetContainerId: string;
  targetProjectKind?: SidebarThreadProjectKind;
  threadId: string | null;
  threadKind: SidebarThreadKind;
}

interface SidebarThreadDropRect {
  bottom: number;
  top: number;
}

export interface SidebarThreadReorderController {
  handleDragStart?: (event: DragStartEvent) => void;
  handleDragOver?: (event: DragMoveEvent | DragOverEvent, pointerY: number | null) => void;
  handleDragCancel?: (event?: DragCancelEvent | DragEndEvent) => void;
  handleDragEnd: (event: DragEndEvent, pointerY: number | null) => void;
}

type SidebarThreadDndPayload = SidebarThreadContainerDndPayload | SidebarThreadItemDndPayload;
type SidebarThreadTargetDndPayload = SidebarThreadDndPayload | SidebarGroupDndPayload;

interface SidebarThreadReorderContextValue {
  activeThread: SidebarThreadDndThread | null;
  activeThreadKey: string | null;
  dragActive: boolean;
  homeContainerIdByThreadId: ReadonlyMap<string, string>;
  pendingThreadDrops: PendingSidebarThreadDrop[];
  reportCanonicalLanes: (lanes: SidebarThreadCanonicalLanes) => void;
  reportError: (error: unknown) => void;
}

export interface PendingVisibleThreadOrder {
  previousVisibleThreadKeys: string[];
  nextVisibleThreadKeys: string[];
}

const DEFAULT_REPORT_ERROR = (error: unknown): void => {
  console.error("Sidebar task reorder failed", error);
};
const DEFAULT_REPORT_CANONICAL_LANES = (): void => undefined;

const SidebarThreadReorderContext = createContext<SidebarThreadReorderContextValue>({
  activeThread: null,
  activeThreadKey: null,
  dragActive: false,
  homeContainerIdByThreadId: new Map(),
  pendingThreadDrops: [],
  reportCanonicalLanes: DEFAULT_REPORT_CANONICAL_LANES,
  reportError: DEFAULT_REPORT_ERROR,
});

function createSidebarThreadDropOperationId(): string {
  return `sidebar-thread-drop:${createUuidV7()}`;
}

export function readSidebarThreadDndPayload(value: unknown): SidebarThreadDndPayload | null {
  if (!value || typeof value !== "object") return null;
  const kind = Reflect.get(value, "kind");
  if (kind === "sidebar-item") return value as SidebarThreadItemDndPayload;
  if (kind === "sidebar-thread-container") {
    return value as SidebarThreadContainerDndPayload;
  }
  return null;
}

function readSidebarThreadTargetDndPayload(value: unknown): SidebarThreadTargetDndPayload | null {
  const threadPayload = readSidebarThreadDndPayload(value);
  if (threadPayload) return threadPayload;
  const projectPayload = readSidebarGroupDndPayload(value);
  if (!projectPayload?.containerId) return null;
  return readSidebarSectionContainerId(projectPayload.containerId) ? projectPayload : null;
}

function isProjectContainerId(containerId: string): boolean {
  return containerId.startsWith("project:") || containerId.startsWith("project-pinned:");
}

function isCloudContainerId(containerId: string | null): boolean {
  return containerId === "cloud";
}

export function resolveSidebarThreadDropPolicy({
  homeContainerId,
  sourceContainerId,
  sourceProjectKind,
  targetContainerId,
  targetProjectKind,
  threadId,
  threadKind,
}: SidebarThreadDropPolicyInput): SidebarThreadDropPolicy {
  const resolvedSourceProjectKind =
    threadKind === "remote" ? "remote" : (sourceProjectKind ?? "local");
  if (targetProjectKind !== undefined && resolvedSourceProjectKind !== targetProjectKind) {
    return { status: "blocked", reason: "project-kind-mismatch" };
  }

  if (threadKind === "remote" || sourceProjectKind === "remote" || targetProjectKind === "remote") {
    return { status: "blocked", reason: "remote-deferred" };
  }
  if (
    isCloudContainerId(sourceContainerId) ||
    isCloudContainerId(targetContainerId) ||
    isCloudContainerId(homeContainerId)
  ) {
    return { status: "blocked", reason: "cloud-deferred" };
  }

  if (sourceContainerId === targetContainerId) {
    return threadId !== null || threadKind === "local"
      ? { status: "allowed" }
      : { status: "blocked", reason: "unsupported-target" };
  }
  if (sourceContainerId.startsWith("reorder-only:")) {
    return { status: "blocked", reason: "reorder-only-source" };
  }
  if (threadId === null) {
    return { status: "blocked", reason: "pending-cross-container" };
  }
  if (targetContainerId === "pinned" || isProjectContainerId(targetContainerId)) {
    return { status: "allowed" };
  }
  if (readSidebarSectionContainerId(targetContainerId)) return { status: "allowed" };
  if (
    targetContainerId === "chats" &&
    (isProjectContainerId(sourceContainerId) || sourceContainerId === "pinned")
  ) {
    return { status: "allowed" };
  }
  return { status: "blocked", reason: "unsupported-target" };
}

function sameStringOrder(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((item) => rightSet.has(item));
}

export function moveSidebarThreadBefore(
  visibleThreadKeys: readonly string[],
  activeThreadKey: string,
  beforeThreadKey: string | null,
): string[] {
  if (!visibleThreadKeys.includes(activeThreadKey)) return [...visibleThreadKeys];

  const remainingThreadKeys = visibleThreadKeys.filter(
    (threadKey) => threadKey !== activeThreadKey,
  );
  const insertionIndex =
    beforeThreadKey === null
      ? remainingThreadKeys.length
      : remainingThreadKeys.indexOf(beforeThreadKey);
  if (insertionIndex < 0) return [...visibleThreadKeys];

  return [
    ...remainingThreadKeys.slice(0, insertionIndex),
    activeThreadKey,
    ...remainingThreadKeys.slice(insertionIndex),
  ];
}

export function wouldSidebarItemMoveChangeOrder(
  itemIds: readonly string[],
  activeItemId: string,
  beforeItemId: string | null,
): boolean {
  return !sameStringOrder(itemIds, moveSidebarThreadBefore(itemIds, activeItemId, beforeItemId));
}

export function resolveSidebarThreadDropTarget({
  visibleThreadKeys,
  activeThreadKey,
  overThreadKey,
  activeRect,
  overRect,
  pointerY,
}: {
  visibleThreadKeys: readonly string[];
  activeThreadKey: string | null;
  overThreadKey: string | null;
  activeRect: SidebarThreadDropRect | null;
  overRect: SidebarThreadDropRect | null;
  pointerY: number | null;
}): SidebarThreadDropTarget | null {
  if (!activeThreadKey || !overThreadKey) return null;
  if (activeThreadKey === overThreadKey) return null;
  if (!activeRect || !overRect) return null;

  const remainingThreadKeys = visibleThreadKeys.filter(
    (threadKey) => threadKey !== activeThreadKey,
  );
  const overIndex = remainingThreadKeys.indexOf(overThreadKey);
  if (overIndex < 0) return null;

  const activeMidpoint = (activeRect.top + activeRect.bottom) / 2;
  const overMidpoint = (overRect.top + overRect.bottom) / 2;
  const placement = (pointerY ?? activeMidpoint) < overMidpoint ? "before" : "after";
  const beforeThreadKey = remainingThreadKeys[overIndex + (placement === "after" ? 1 : 0)] ?? null;
  const nextThreadKeys = moveSidebarThreadBefore(
    visibleThreadKeys,
    activeThreadKey,
    beforeThreadKey,
  );
  if (
    visibleThreadKeys.includes(activeThreadKey) &&
    sameStringOrder(visibleThreadKeys, nextThreadKeys)
  ) {
    return null;
  }

  return { beforeThreadKey };
}

export function resolveDisplayedVisibleThreadKeys(
  visibleThreadKeys: string[],
  pendingVisibleThreadOrder: PendingVisibleThreadOrder | null,
): string[] {
  if (!pendingVisibleThreadOrder) return visibleThreadKeys;
  if (!sameStringOrder(pendingVisibleThreadOrder.previousVisibleThreadKeys, visibleThreadKeys)) {
    return visibleThreadKeys;
  }
  if (!sameStringSet(pendingVisibleThreadOrder.nextVisibleThreadKeys, visibleThreadKeys)) {
    return visibleThreadKeys;
  }
  return pendingVisibleThreadOrder.nextVisibleThreadKeys;
}

export function resolveSidebarThreadDropIndicatorIndex(
  visibleThreadKeys: readonly string[],
  dropTarget: SidebarThreadDropTarget | null,
): number | null {
  if (!dropTarget) return null;
  if (dropTarget.beforeThreadKey === null) return visibleThreadKeys.length;
  const index = visibleThreadKeys.indexOf(dropTarget.beforeThreadKey);
  return index < 0 ? null : index;
}

export interface SidebarThreadResolvedExternalDropTarget {
  beforeItemId?: string | null;
  beforeThreadId: string | null;
  afterThreadId?: string;
  insertAtEnd?: true;
  targetContainerId: string;
  targetItemIds?: string[];
  targetProjectKind?: SidebarThreadProjectKind;
  useDefaultOrder?: true;
}

function resolveTargetThreadId(
  threadKey: string | null,
  getThreadIdByThreadKey: (threadKey: string) => string | null,
): string | null {
  if (threadKey === null) return null;
  return getThreadIdByThreadKey(threadKey);
}

export function resolveSidebarThreadExternalDropTarget(
  event: DragMoveEvent | DragOverEvent | DragEndEvent,
  pointerY: number | null,
  getThreadIdByThreadKey: (threadKey: string) => string | null,
): SidebarThreadResolvedExternalDropTarget | null {
  const activePayload = readSidebarThreadDndPayload(event.active.data.current);
  if (activePayload?.kind !== "sidebar-item") return null;

  const overPayload = readSidebarThreadTargetDndPayload(event.over?.data.current);
  if (!overPayload) return null;

  if (overPayload.kind === "sidebar-thread-container") {
    const targetContainerId = resolveSidebarThreadContainerTargetId(
      overPayload,
      activePayload.thread.containerId,
    );
    const beforeItemId = overPayload.beforeItemId;
    const target: SidebarThreadResolvedExternalDropTarget = {
      beforeThreadId: null,
      targetContainerId,
      targetProjectKind: overPayload.targetProjectKind,
      ...(beforeItemId === undefined ? {} : { beforeItemId }),
      ...(overPayload.itemIds === undefined ? {} : { targetItemIds: overPayload.itemIds }),
      ...(beforeItemId === null && overPayload.itemIds !== undefined
        ? { insertAtEnd: true as const }
        : {}),
      ...(isProjectContainerId(targetContainerId) ? { useDefaultOrder: true as const } : {}),
    };
    return isUnchangedSidebarThreadDrop(activePayload.thread, target, activePayload.itemId)
      ? null
      : target;
  }

  const activeRect = event.active.rect.current.translated;
  if (!activeRect || !event.over) return null;

  if (overPayload.kind === "sidebar-group") {
    if (!overPayload.containerId || !overPayload.itemId || !overPayload.itemIds) return null;
    const placement =
      (pointerY ?? (activeRect.top + activeRect.bottom) / 2) <
      (event.over.rect.top + event.over.rect.bottom) / 2
        ? "before"
        : "after";
    const beforeItemId =
      placement === "before" ? overPayload.itemId : (overPayload.nextItemId ?? null);
    return {
      beforeItemId,
      beforeThreadId: null,
      ...(beforeItemId === null ? { insertAtEnd: true as const } : {}),
      targetContainerId: overPayload.containerId,
      targetItemIds: overPayload.itemIds,
      targetProjectKind: "local",
    };
  }

  const targetThread = overPayload.thread;
  const placement =
    (pointerY ?? (activeRect.top + activeRect.bottom) / 2) <
    (event.over.rect.top + event.over.rect.bottom) / 2
      ? "before"
      : "after";
  const nextThreadKey = targetThread.getNextThreadKey?.() ?? targetThread.nextThreadKey ?? null;
  const nextThreadId =
    targetThread.getNextThreadId?.() ??
    resolveTargetThreadId(nextThreadKey, getThreadIdByThreadKey);
  const beforeThreadId = placement === "before" ? targetThread.threadId : nextThreadId;
  const targetItemId = overPayload.itemIds?.find((itemId) => itemId === String(event.over?.id));
  const beforeItemId =
    targetItemId === undefined
      ? undefined
      : placement === "before"
        ? targetItemId
        : (overPayload.nextItemId ?? null);
  const reachesEnd = beforeThreadId === null && nextThreadKey === null;
  const reachesItemEnd = beforeItemId === null && overPayload.nextItemId === null;

  const target: SidebarThreadResolvedExternalDropTarget = {
    beforeThreadId,
    ...(reachesEnd && targetThread.threadId !== null
      ? { afterThreadId: targetThread.threadId }
      : {}),
    targetContainerId: targetThread.containerId,
    targetProjectKind: targetThread.targetProjectKind,
    ...(beforeItemId === undefined ? {} : { beforeItemId }),
    ...(overPayload.itemIds === undefined ? {} : { targetItemIds: overPayload.itemIds }),
    ...(reachesItemEnd && !reachesEnd ? { insertAtEnd: true as const } : {}),
  };
  return isUnchangedSidebarThreadDrop(activePayload.thread, target, activePayload.itemId)
    ? null
    : target;
}

function isUnchangedSidebarThreadDrop(
  activeThread: SidebarThreadDndThread,
  target: SidebarThreadResolvedExternalDropTarget,
  activeItemId?: string,
): boolean {
  if (activeThread.threadId === null) return false;
  if (activeThread.containerId !== target.targetContainerId) return false;
  if (target.useDefaultOrder) return true;
  if (
    activeItemId !== undefined &&
    target.beforeItemId !== undefined &&
    target.targetItemIds?.includes(activeItemId)
  ) {
    return !wouldSidebarItemMoveChangeOrder(
      target.targetItemIds,
      activeItemId,
      target.beforeItemId,
    );
  }

  const activeThreadId = activeThread.threadId;
  if (target.beforeThreadId === activeThreadId || target.afterThreadId === activeThreadId) {
    return true;
  }

  const nextThreadId = activeThread.getNextThreadId?.();
  if (target.beforeThreadId !== null) {
    return nextThreadId !== undefined && target.beforeThreadId === nextThreadId;
  }
  if (target.insertAtEnd) return nextThreadId === null;
  if (target.afterThreadId !== undefined) return false;

  return activeThread.getPreviousThreadId?.() === null;
}

export function resolveSidebarThreadKeysWithPendingDrops({
  containerId,
  pendingThreadDrops,
  threadKeys,
  threadKeysInDisplayOrder,
  getThreadId = (threadKey) => threadKey,
}: {
  containerId: string;
  pendingThreadDrops: readonly PendingSidebarThreadDrop[];
  threadKeys: readonly string[];
  threadKeysInDisplayOrder?: readonly string[] | null;
  getThreadId?: (threadKey: string) => string | null;
}): string[] {
  const threadKeySet = new Set(threadKeys);
  const displayThreadKeySet = new Set(threadKeysInDisplayOrder);
  let nextThreadKeys =
    containerId === "chats" && threadKeysInDisplayOrder
      ? [
          ...threadKeysInDisplayOrder.filter((threadKey) => threadKeySet.has(threadKey)),
          ...threadKeys.filter((threadKey) => !displayThreadKeySet.has(threadKey)),
        ]
      : [...threadKeys];

  for (const pendingDrop of pendingThreadDrops) {
    const remainingThreadKeys = nextThreadKeys.includes(pendingDrop.threadKey)
      ? nextThreadKeys.filter((threadKey) => threadKey !== pendingDrop.threadKey)
      : nextThreadKeys;
    if (containerId !== pendingDrop.targetContainerId) {
      nextThreadKeys = remainingThreadKeys;
      continue;
    }

    const afterAnchorIndex =
      pendingDrop.afterThreadId === undefined
        ? -1
        : remainingThreadKeys.findIndex(
            (threadKey) => getThreadId(threadKey) === pendingDrop.afterThreadId,
          );
    const rawInsertionIndex = pendingDrop.insertAtEnd
      ? remainingThreadKeys.length
      : afterAnchorIndex >= 0
        ? afterAnchorIndex + 1
        : pendingDrop.beforeThreadId === null
          ? 0
          : remainingThreadKeys.findIndex(
              (threadKey) => getThreadId(threadKey) === pendingDrop.beforeThreadId,
            );
    const insertionIndex = rawInsertionIndex < 0 ? remainingThreadKeys.length : rawInsertionIndex;
    nextThreadKeys = [
      ...remainingThreadKeys.slice(0, insertionIndex),
      pendingDrop.threadKey,
      ...remainingThreadKeys.slice(insertionIndex),
    ];
  }
  return nextThreadKeys;
}

function canonicalLaneContainsDropPlacement(
  pendingDrop: PendingSidebarThreadDrop,
  targetThreadIds: readonly string[],
): boolean {
  const movedIndex = targetThreadIds.indexOf(pendingDrop.threadId);
  if (movedIndex < 0) return false;
  if (pendingDrop.useDefaultOrder) return true;

  if (pendingDrop.afterThreadId !== undefined) {
    const anchorIndex = targetThreadIds.indexOf(pendingDrop.afterThreadId);
    return anchorIndex >= 0 && movedIndex === anchorIndex + 1;
  }
  if (pendingDrop.insertAtEnd) return movedIndex === targetThreadIds.length - 1;
  if (pendingDrop.beforeThreadId === null) return movedIndex === 0;

  const anchorIndex = targetThreadIds.indexOf(pendingDrop.beforeThreadId);
  return anchorIndex >= 0 && movedIndex + 1 === anchorIndex;
}

function canonicalLanesContainCommittedDrop(
  pendingDrop: PendingSidebarThreadDrop,
  lanes: SidebarThreadCanonicalLanes,
): boolean {
  const targetLane = lanes.get(pendingDrop.targetContainerId);
  if (!targetLane) return false;
  if (!canonicalLaneContainsDropPlacement(pendingDrop, targetLane.threadIds)) return false;
  if (pendingDrop.sourceContainerId === pendingDrop.targetContainerId) return true;

  const sourceLane = lanes.get(pendingDrop.sourceContainerId);
  return sourceLane === undefined || !sourceLane.threadIds.includes(pendingDrop.threadId);
}

function laterCanonicalLaneSupersedesDrop(
  pendingDrop: PendingSidebarThreadDrop,
  lanes: SidebarThreadCanonicalLanes,
): boolean {
  if (pendingDrop.projectionRevision === undefined) return false;
  for (const [containerId, lane] of lanes) {
    if (lane.projectionRevision === null) continue;
    if (lane.projectionRevision <= pendingDrop.projectionRevision) continue;
    if (!lane.threadIds.includes(pendingDrop.threadId)) continue;
    if (containerId !== pendingDrop.targetContainerId) return true;
    return !canonicalLaneContainsDropPlacement(pendingDrop, lane.threadIds);
  }
  return false;
}

/**
 * Removes acknowledged overlays only after the canonical lanes rendered by
 * React contain the committed placement, or a later projection explicitly
 * supersedes it. Cache installation alone is not a render acknowledgement.
 */
export function reconcilePendingSidebarThreadDrops(
  pendingDrops: PendingSidebarThreadDrop[],
  lanes: SidebarThreadCanonicalLanes,
): PendingSidebarThreadDrop[] {
  const next = pendingDrops.filter((pendingDrop) => {
    if (pendingDrop.phase !== "acknowledged") return true;
    if (canonicalLanesContainCommittedDrop(pendingDrop, lanes)) return false;
    return !laterCanonicalLaneSupersedesDrop(pendingDrop, lanes);
  });
  return next.length === pendingDrops.length ? pendingDrops : next;
}

export function getSidebarThreadContainerEdgeInsetY(
  payload: SidebarThreadContainerDndPayload,
): number {
  if (!isProjectContainerId(payload.containerId)) return 0;
  if (
    payload.projectDropZone === "project-gutter" ||
    payload.projectDropZone === "project-icon" ||
    payload.projectDropZone === "project-pagination"
  ) {
    return 0;
  }
  return payload.projectDropZone === "project-row" ? 7 : 10;
}

function containsPoint({
  point,
  rect,
  edgeInsetY = 0,
}: {
  point: { x: number; y: number };
  rect: { bottom: number; left: number; right: number; top: number };
  edgeInsetY?: number;
}): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top + edgeInsetY &&
    point.y <= rect.bottom - edgeInsetY
  );
}

function targetContainerDetails(
  payload: SidebarThreadTargetDndPayload,
  sourceContainerId: string,
): {
  containerId: string;
  targetProjectKind?: SidebarThreadProjectKind;
} {
  if (payload.kind === "sidebar-thread-container") {
    return {
      containerId: resolveSidebarThreadContainerTargetId(payload, sourceContainerId),
      targetProjectKind: payload.targetProjectKind,
    };
  }
  if (payload.kind === "sidebar-group") {
    return {
      containerId: payload.containerId ?? sourceContainerId,
      targetProjectKind: "local",
    };
  }
  return {
    containerId: payload.thread.containerId,
    targetProjectKind: payload.thread.targetProjectKind,
  };
}

function isSidebarThreadTargetAllowed({
  activePayload,
  homeContainerIdByThreadId,
  targetPayload,
}: {
  activePayload: SidebarThreadItemDndPayload;
  homeContainerIdByThreadId: ReadonlyMap<string, string>;
  targetPayload: SidebarThreadTargetDndPayload;
}): boolean {
  const activeThread = activePayload.thread;
  const target = targetContainerDetails(targetPayload, activeThread.containerId);
  return (
    resolveSidebarThreadDropPolicy({
      homeContainerId:
        activeThread.threadId === null
          ? null
          : (homeContainerIdByThreadId.get(activeThread.threadId) ?? null),
      sourceContainerId: activeThread.containerId,
      sourceProjectKind: activeThread.sourceProjectKind,
      targetContainerId: target.containerId,
      targetProjectKind: target.targetProjectKind,
      threadId: activeThread.threadId,
      threadKind: activeThread.sourceProjectKind === "remote" ? "remote" : "local",
    }).status === "allowed"
  );
}

export function createSidebarThreadCollisionDetection(
  homeContainerIdByThreadId: ReadonlyMap<string, string>,
): CollisionDetection {
  return (args) => {
    const activePayload = readSidebarThreadDndPayload(args.active.data.current);
    if (activePayload?.kind !== "sidebar-item") return closestCenter(args);

    const eligibleContainers = args.droppableContainers.filter((container) => {
      const targetPayload = readSidebarThreadTargetDndPayload(container.data.current);
      if (!targetPayload) return false;
      return isSidebarThreadTargetAllowed({
        activePayload,
        homeContainerIdByThreadId,
        targetPayload,
      });
    });
    const eligibleArgs = {
      ...args,
      droppableContainers: eligibleContainers,
    };
    if (!args.pointerCoordinates) return closestCenter(eligibleArgs);

    const point = args.pointerCoordinates;
    const rowTargets = eligibleContainers.filter(
      (container) =>
        readSidebarThreadTargetDndPayload(container.data.current)?.kind !==
        "sidebar-thread-container",
    );
    const containerTargets = eligibleContainers.filter(
      (container) =>
        readSidebarThreadDndPayload(container.data.current)?.kind === "sidebar-thread-container",
    );
    const isAtPoint = (container: (typeof eligibleContainers)[number]): boolean => {
      const rect = args.droppableRects.get(container.id);
      const payload = readSidebarThreadTargetDndPayload(container.data.current);
      if (!rect || !payload) return false;
      const edgeInsetY =
        payload.kind === "sidebar-thread-container"
          ? getSidebarThreadContainerEdgeInsetY(payload)
          : 0;
      return containsPoint({ point, rect, edgeInsetY });
    };
    const isAncestorOf = (
      ancestor: (typeof eligibleContainers)[number],
      descendant: (typeof eligibleContainers)[number],
    ): boolean => {
      const ancestorNode = ancestor.node.current;
      const descendantNode = descendant.node.current;
      return (
        ancestorNode !== null && descendantNode !== null && ancestorNode.contains(descendantNode)
      );
    };

    const guaranteedContainerTargets = containerTargets.filter((container) => {
      const payload = readSidebarThreadTargetDndPayload(container.data.current);
      return (
        payload?.kind === "sidebar-thread-container" &&
        (payload.projectDropZone === "project-gutter" ||
          payload.projectDropZone === "project-icon" ||
          payload.projectDropZone === "project-pagination") &&
        isAtPoint(container)
      );
    });

    let selectedTargets = guaranteedContainerTargets;
    if (selectedTargets.length === 0) {
      const reorderBoundaryTargets = containerTargets.filter((container) => {
        const payload = readSidebarThreadTargetDndPayload(container.data.current);
        const rect = args.droppableRects.get(container.id);
        if (
          payload?.kind !== "sidebar-thread-container" ||
          !isProjectContainerId(payload.containerId) ||
          payload.projectDropZone === "project-icon" ||
          !rect
        ) {
          return false;
        }
        return (
          containsPoint({ point, rect }) &&
          !containsPoint({
            point,
            rect,
            edgeInsetY: getSidebarThreadContainerEdgeInsetY(payload),
          })
        );
      });
      const boundaryRowTargets = rowTargets.filter((rowTarget) =>
        reorderBoundaryTargets.some((containerTarget) => isAncestorOf(containerTarget, rowTarget)),
      );
      if (boundaryRowTargets.length > 0) {
        selectedTargets = boundaryRowTargets;
      } else {
        const pointRowTargets = rowTargets.filter(isAtPoint);
        const pointContainerTargets = containerTargets.filter(isAtPoint);
        const deepestContainerTargets = pointContainerTargets.filter(
          (containerTarget) =>
            !pointContainerTargets.some(
              (otherTarget) =>
                otherTarget !== containerTarget && isAncestorOf(containerTarget, otherTarget),
            ),
        );
        const rowContainingContainerTargets = deepestContainerTargets.filter((containerTarget) =>
          pointRowTargets.some(
            (rowTarget) =>
              isAncestorOf(rowTarget, containerTarget) &&
              !pointRowTargets.some((otherRowTarget) =>
                isAncestorOf(containerTarget, otherRowTarget),
              ),
          ),
        );
        const rowsInsideContainerTargets = pointRowTargets.filter((rowTarget) =>
          deepestContainerTargets.some((containerTarget) =>
            isAncestorOf(containerTarget, rowTarget),
          ),
        );
        selectedTargets =
          rowContainingContainerTargets.length > 0
            ? rowContainingContainerTargets
            : rowsInsideContainerTargets.length > 0
              ? rowsInsideContainerTargets
              : pointRowTargets.length > 0
                ? pointRowTargets
                : deepestContainerTargets;
      }
    }

    if (selectedTargets.length === 0) return [];
    const { x, y } = point;
    return closestCenter({
      ...args,
      droppableContainers: selectedTargets,
      collisionRect: {
        ...args.collisionRect,
        bottom: y,
        height: 0,
        left: x,
        right: x,
        top: y,
        width: 0,
      },
    });
  };
}

export type SidebarThreadDragEndDisposition = "cancelled" | "moved" | "reordered";

export function dispatchSidebarThreadDragEnd({
  destinationController,
  event,
  getThreadIdByThreadKey,
  homeContainerIdByThreadId,
  onError,
  onThreadDrop,
  pointerY,
  updatePendingThreadDrops,
}: {
  destinationController: SidebarThreadReorderController | null;
  event: DragEndEvent;
  getThreadIdByThreadKey: (threadKey: string) => string | null;
  homeContainerIdByThreadId: ReadonlyMap<string, string>;
  onError: (error: unknown) => void;
  onThreadDrop: (
    drop: SidebarThreadDropRequest,
  ) => Promise<SidebarThreadDropCommit | null> | SidebarThreadDropCommit | null;
  pointerY: number | null;
  updatePendingThreadDrops: (
    update: (current: PendingSidebarThreadDrop[]) => PendingSidebarThreadDrop[],
  ) => void;
}): SidebarThreadDragEndDisposition {
  destinationController?.handleDragCancel?.(event);
  const activePayload = readSidebarThreadDndPayload(event.active.data.current);
  if (activePayload?.kind !== "sidebar-item") return "cancelled";

  const overPayload = readSidebarThreadTargetDndPayload(event.over?.data.current);
  if (!overPayload) {
    activePayload.controller.handleDragCancel?.(event);
    return "cancelled";
  }
  const sameController =
    overPayload.kind !== "sidebar-thread-container" &&
    overPayload.controller === activePayload.controller;
  if (
    sameController &&
    (activePayload.itemId !== undefined ||
      isCodexSidebarPinnedThreadContainerId(activePayload.thread.containerId))
  ) {
    activePayload.controller.handleDragEnd(event, pointerY);
    return "reordered";
  }
  if (
    !isSidebarThreadTargetAllowed({
      activePayload,
      homeContainerIdByThreadId,
      targetPayload: overPayload,
    })
  ) {
    activePayload.controller.handleDragCancel?.(event);
    return "cancelled";
  }

  const resolvedDropTarget = resolveSidebarThreadExternalDropTarget(
    event,
    pointerY,
    getThreadIdByThreadKey,
  );
  if (!resolvedDropTarget) {
    activePayload.controller.handleDragCancel?.(event);
    return "cancelled";
  }
  const dropTarget = resolvedDropTarget;
  const activeThread = activePayload.thread;
  activePayload.controller.handleDragCancel?.(event);
  if (activeThread.threadId === null) return "cancelled";

  const optimisticDrop: PendingSidebarThreadDrop = {
    beforeThreadId: dropTarget.beforeThreadId,
    ...(dropTarget.afterThreadId === undefined ? {} : { afterThreadId: dropTarget.afterThreadId }),
    homeContainerId: homeContainerIdByThreadId.get(activeThread.threadId) ?? null,
    operationId: createSidebarThreadDropOperationId(),
    phase: "submitting",
    sourceContainerId: activeThread.containerId,
    targetContainerId: dropTarget.targetContainerId,
    threadId: activeThread.threadId,
    threadKey: activeThread.threadKey,
    ...(dropTarget.insertAtEnd ? { insertAtEnd: true } : {}),
    ...(dropTarget.useDefaultOrder ? { useDefaultOrder: true } : {}),
  };
  updatePendingThreadDrops((current) => [
    ...current.filter((pendingDrop) => pendingDrop.threadId !== activeThread.threadId),
    optimisticDrop,
  ]);

  void Promise.resolve()
    .then(() =>
      onThreadDrop({
        beforeThreadId: dropTarget.beforeThreadId,
        ...(dropTarget.afterThreadId === undefined
          ? {}
          : { afterThreadId: dropTarget.afterThreadId }),
        sourceContainerId: activeThread.containerId,
        targetContainerId: dropTarget.targetContainerId,
        threadId: activeThread.threadId as string,
        ...(dropTarget.beforeItemId === undefined ? {} : { beforeItemId: dropTarget.beforeItemId }),
        ...(dropTarget.insertAtEnd ? { insertAtEnd: true } : {}),
        ...(dropTarget.useDefaultOrder ? { useDefaultOrder: true } : {}),
        ...(activePayload.itemId === undefined ? {} : { itemId: activePayload.itemId }),
        ...(dropTarget.targetItemIds === undefined
          ? {}
          : { targetItemIds: dropTarget.targetItemIds }),
      }),
    )
    .then((commit) => {
      updatePendingThreadDrops((current) =>
        commit === null
          ? current.filter((pendingDrop) => pendingDrop.operationId !== optimisticDrop.operationId)
          : current.map((pendingDrop) =>
              pendingDrop.operationId === optimisticDrop.operationId
                ? {
                    ...pendingDrop,
                    commitOperationId: commit.operationId,
                    phase: "acknowledged",
                    projectionRevision: commit.projectionRevision,
                  }
                : pendingDrop,
            ),
      );
    })
    .catch((error: unknown) => {
      updatePendingThreadDrops((current) =>
        current.filter((pendingDrop) => pendingDrop.operationId !== optimisticDrop.operationId),
      );
      onError(error);
    });
  return "moved";
}

const EMPTY_HOME_CONTAINER_IDS: ReadonlyMap<string, string> = new Map();
const DEFAULT_GET_THREAD_ID = (threadKey: string): string => threadKey;
const EMPTY_PENDING_THREAD_DROPS: PendingSidebarThreadDrop[] = [];

export function SidebarThreadDndStateProvider({
  activeThread,
  children,
  homeContainerIdByThreadId = EMPTY_HOME_CONTAINER_IDS,
  onError = DEFAULT_REPORT_ERROR,
  pendingThreadDrops = EMPTY_PENDING_THREAD_DROPS,
  reportCanonicalLanes = DEFAULT_REPORT_CANONICAL_LANES,
}: {
  activeThread: SidebarThreadDndThread | null;
  children: ReactNode;
  homeContainerIdByThreadId?: ReadonlyMap<string, string>;
  onError?: (error: unknown) => void;
  pendingThreadDrops?: PendingSidebarThreadDrop[];
  reportCanonicalLanes?: (lanes: SidebarThreadCanonicalLanes) => void;
}) {
  const contextValue = useMemo<SidebarThreadReorderContextValue>(
    () => ({
      activeThread,
      activeThreadKey: activeThread?.threadKey ?? null,
      dragActive: activeThread !== null,
      homeContainerIdByThreadId,
      pendingThreadDrops,
      reportCanonicalLanes,
      reportError: onError,
    }),
    [activeThread, homeContainerIdByThreadId, onError, pendingThreadDrops, reportCanonicalLanes],
  );

  return (
    <SidebarThreadReorderContext.Provider value={contextValue}>
      {children}
    </SidebarThreadReorderContext.Provider>
  );
}

export function usePendingSidebarThreadDrops(): readonly PendingSidebarThreadDrop[] {
  return useContext(SidebarThreadReorderContext).pendingThreadDrops;
}

export function useReportSidebarThreadCanonicalLanes(lanes: SidebarThreadCanonicalLanes): void {
  const { reportCanonicalLanes } = useContext(SidebarThreadReorderContext);
  useLayoutEffect(() => {
    reportCanonicalLanes(lanes);
  }, [lanes, reportCanonicalLanes]);
}

export function resolveSidebarThreadProjectDropContainerId(
  projectId: string,
  sourceContainerId: string | null,
): string {
  return codexSidebarProjectThreadContainerId(
    projectId,
    isCodexSidebarPinnedThreadContainerId(sourceContainerId ?? ""),
  );
}

export function getSidebarThreadProjectDropContainerId(projectId: string): string {
  return codexSidebarProjectThreadContainerId(projectId, false);
}

export function resolveSidebarThreadContainerTargetId(
  payload: SidebarThreadContainerDndPayload,
  sourceContainerId: string | null,
): string {
  if (payload.preserveSourceProjectLane !== true) {
    return payload.containerId;
  }
  if (!payload.containerId.startsWith("project:")) {
    return payload.containerId;
  }

  const projectId = payload.containerId.slice("project:".length);
  if (!projectId) return payload.containerId;
  return resolveSidebarThreadProjectDropContainerId(projectId, sourceContainerId);
}

interface SidebarThreadDropContainerOptions {
  acceptProjectDrop?: boolean;
  beforeItemId?: string | null;
  containerId: string;
  itemIds?: string[];
  projectDropZone?: SidebarThreadProjectDropZone;
  targetProjectKind?: SidebarThreadProjectKind;
}

interface SidebarThreadDropContainerRegistration {
  isExternalThreadDropTarget: boolean;
  isOver: boolean;
  isProjectDropTargetOver: boolean;
  projectDragActive: boolean;
  setNodeRef: (element: HTMLElement | null) => void;
  threadDragActive: boolean;
}

function useSidebarThreadDropContainerRegistration({
  acceptProjectDrop = false,
  beforeItemId,
  containerId,
  itemIds,
  preserveSourceProjectLane,
  projectDropZone,
  targetProjectKind,
}: SidebarThreadDropContainerOptions & {
  acceptProjectDrop?: boolean;
  preserveSourceProjectLane: boolean;
}): SidebarThreadDropContainerRegistration {
  const { activeThread, homeContainerIdByThreadId } = useContext(SidebarThreadReorderContext);
  const { projectDragActive } = useSidebarProjectDndState();
  const payload = useMemo<SidebarThreadContainerDndPayload>(
    () => ({
      kind: "sidebar-thread-container",
      beforeItemId,
      containerId,
      itemIds,
      ...(preserveSourceProjectLane ? { preserveSourceProjectLane: true as const } : {}),
      projectDropZone,
      targetProjectKind,
    }),
    [
      beforeItemId,
      containerId,
      itemIds,
      preserveSourceProjectLane,
      projectDropZone,
      targetProjectKind,
    ],
  );
  const targetContainerId = resolveSidebarThreadContainerTargetId(
    payload,
    activeThread?.containerId ?? null,
  );
  const policy =
    activeThread === null
      ? null
      : resolveSidebarThreadDropPolicy({
          homeContainerId:
            activeThread.threadId === null
              ? null
              : (homeContainerIdByThreadId.get(activeThread.threadId) ?? null),
          sourceContainerId: activeThread.containerId,
          sourceProjectKind: activeThread.sourceProjectKind,
          targetContainerId,
          targetProjectKind,
          threadId: activeThread.threadId,
          threadKind: activeThread.sourceProjectKind === "remote" ? "remote" : "local",
        });
  const id =
    projectDropZone === undefined
      ? `sidebar-thread-container:${containerId}`
      : `sidebar-${projectDropZone}:${containerId}`;
  const { isOver, over, setNodeRef } = useDroppable({
    id,
    data: payload,
    disabled: !(acceptProjectDrop && projectDragActive) && policy?.status !== "allowed",
  });
  const isExternalThreadDropTarget =
    policy?.status === "allowed" && activeThread?.containerId !== targetContainerId;
  const overPayload = readSidebarThreadDndPayload(over?.data.current);
  const overContainerId =
    overPayload?.kind === "sidebar-thread-container"
      ? resolveSidebarThreadContainerTargetId(overPayload, activeThread?.containerId ?? null)
      : null;
  return {
    isExternalThreadDropTarget,
    isOver,
    isProjectDropTargetOver:
      isExternalThreadDropTarget &&
      isProjectContainerId(targetContainerId) &&
      overContainerId === targetContainerId,
    projectDragActive: acceptProjectDrop && projectDragActive,
    setNodeRef,
    threadDragActive: policy?.status === "allowed",
  };
}

export function useSidebarThreadDropContainer(
  options: SidebarThreadDropContainerOptions,
): SidebarThreadDropContainerRegistration {
  return useSidebarThreadDropContainerRegistration({
    ...options,
    acceptProjectDrop: options.acceptProjectDrop,
    preserveSourceProjectLane: false,
  });
}

export function useSidebarPinnedDropContainer(): SidebarThreadDropContainerRegistration {
  return useSidebarThreadDropContainerRegistration({
    acceptProjectDrop: true,
    containerId: PINNED_PROJECT_CONTAINER_ID,
    preserveSourceProjectLane: false,
    targetProjectKind: "local",
  });
}

export function useSidebarThreadProjectDropTargets({
  projectId,
  targetProjectKind,
}: {
  projectId: string;
  targetProjectKind: SidebarThreadProjectKind;
}): {
  gutter: SidebarThreadDropContainerRegistration;
  icon: SidebarThreadDropContainerRegistration;
  row: SidebarThreadDropContainerRegistration;
  whole: SidebarThreadDropContainerRegistration;
} {
  const containerId = getSidebarThreadProjectDropContainerId(projectId);
  const whole = useSidebarThreadDropContainerRegistration({
    containerId,
    preserveSourceProjectLane: true,
    targetProjectKind,
  });
  const row = useSidebarThreadDropContainerRegistration({
    containerId,
    preserveSourceProjectLane: true,
    projectDropZone: "project-row",
    targetProjectKind,
  });
  const icon = useSidebarThreadDropContainerRegistration({
    containerId,
    preserveSourceProjectLane: true,
    projectDropZone: "project-icon",
    targetProjectKind,
  });
  const gutter = useSidebarThreadDropContainerRegistration({
    containerId,
    preserveSourceProjectLane: true,
    projectDropZone: "project-gutter",
    targetProjectKind,
  });
  return { gutter, icon, row, whole };
}

export function SidebarThreadDropContainer({
  acceptProjectDrop = false,
  activeClassName,
  activeNode,
  children,
  className,
  containerId,
  projectDropZone,
  targetProjectKind,
}: {
  acceptProjectDrop?: boolean;
  activeClassName?: string;
  activeNode?: ReactNode;
  children: ReactNode;
  className?: string;
  containerId: string;
  projectDropZone?: SidebarThreadProjectDropZone;
  targetProjectKind?: SidebarThreadProjectKind;
}) {
  const { isExternalThreadDropTarget, isOver, projectDragActive, setNodeRef } =
    useSidebarThreadDropContainerRegistration({
      acceptProjectDrop,
      containerId,
      preserveSourceProjectLane: false,
      projectDropZone,
      targetProjectKind,
    });
  const active = isOver && (isExternalThreadDropTarget || projectDragActive);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        className,
        active && activeClassName,
        active &&
          "cursor-grabbing rounded-md bg-token-list-hover-background [&>*]:pointer-events-none",
      )}
      data-sidebar-project-drop-zone={projectDropZone}
      data-sidebar-project-kind={targetProjectKind}
    >
      {children}
      {active ? activeNode : null}
    </div>
  );
}

export function useSidebarThreadReorderController({
  visibleThreadKeys,
  onVisibleThreadOrderChange,
}: {
  visibleThreadKeys: string[];
  onVisibleThreadOrderChange?: (change: {
    activeThreadKey: string;
    visibleThreadKeys: string[];
    nextVisibleThreadKeys: string[];
  }) => Promise<void>;
}): {
  controller: SidebarThreadReorderController;
  displayedVisibleThreadKeys: string[];
  dropIndicatorTarget: SidebarThreadDropTarget | null;
} {
  const { reportError } = useContext(SidebarThreadReorderContext);
  const [dropIndicatorTarget, setDropIndicatorTarget] = useState<SidebarThreadDropTarget | null>(
    null,
  );
  const orderHandoff = useCanonicalOrderHandoff({
    canonicalIds: visibleThreadKeys,
    reportError,
  });
  const displayedVisibleThreadKeys = useMemo(
    () => [...orderHandoff.displayedIds],
    [orderHandoff.displayedIds],
  );

  const resolveDropTarget = useCallback(
    (event: DragMoveEvent | DragOverEvent | DragEndEvent, pointerY: number | null) =>
      resolveSidebarThreadDropTarget({
        visibleThreadKeys: displayedVisibleThreadKeys,
        activeThreadKey: String(event.active.id),
        overThreadKey: event.over ? String(event.over.id) : null,
        activeRect: event.active.rect.current.translated,
        overRect: event.over?.rect ?? null,
        pointerY,
      }),
    [displayedVisibleThreadKeys],
  );

  const controller = useMemo<SidebarThreadReorderController>(
    () => ({
      handleDragOver(event, pointerY) {
        setDropIndicatorTarget(resolveDropTarget(event, pointerY));
      },
      handleDragCancel() {
        setDropIndicatorTarget(null);
      },
      handleDragEnd(event, pointerY) {
        const activeThreadKey = String(event.active.id);
        const target = resolveDropTarget(event, pointerY);
        setDropIndicatorTarget(null);
        if (!target || !onVisibleThreadOrderChange) return;

        const nextVisibleThreadKeys = moveSidebarThreadBefore(
          displayedVisibleThreadKeys,
          activeThreadKey,
          target.beforeThreadKey,
        );
        orderHandoff.submit(nextVisibleThreadKeys, () =>
          onVisibleThreadOrderChange({
            activeThreadKey,
            visibleThreadKeys: displayedVisibleThreadKeys,
            nextVisibleThreadKeys,
          }),
        );
      },
    }),
    [displayedVisibleThreadKeys, onVisibleThreadOrderChange, orderHandoff, resolveDropTarget],
  );

  return {
    controller,
    displayedVisibleThreadKeys,
    dropIndicatorTarget,
  };
}

export function SidebarThreadSortableContext({
  threadKeys,
  children,
}: {
  threadKeys: string[];
  children: ReactNode;
}) {
  return (
    <SortableContext items={threadKeys} strategy={verticalListSortingStrategy}>
      {children}
    </SortableContext>
  );
}

const legacyContainerIds = new WeakMap<SidebarThreadReorderController, string>();
let nextLegacyContainerId = 0;

function getLegacySidebarThreadContainerId(controller: SidebarThreadReorderController): string {
  const existing = legacyContainerIds.get(controller);
  if (existing) return existing;
  nextLegacyContainerId += 1;
  const containerId = `reorder-only:legacy-${nextLegacyContainerId}`;
  legacyContainerIds.set(controller, containerId);
  return containerId;
}

export function SidebarThreadSortableItem({
  children,
  className,
  containerId,
  controller,
  dragOverlay,
  disabled = false,
  getNextThreadId,
  getNextThreadKey,
  getPreviousThreadId,
  itemId,
  itemIds,
  nextItemId,
  nextThreadKey,
  sourceProjectKind,
  sortableId,
  targetProjectKind,
  threadId,
  threadKey,
}: {
  children: ReactNode;
  className?: string;
  containerId?: string;
  controller: SidebarThreadReorderController;
  dragOverlay?: ReactNode;
  disabled?: boolean;
  getNextThreadId?: () => string | null;
  getNextThreadKey?: () => string | null;
  getPreviousThreadId?: () => string | null;
  itemId?: string;
  itemIds?: string[];
  nextItemId?: string | null;
  nextThreadKey?: string | null;
  sourceProjectKind?: SidebarThreadProjectKind;
  sortableId?: string;
  targetProjectKind?: SidebarThreadProjectKind;
  threadId?: string | null;
  threadKey: string;
}) {
  const { activeThreadKey, dragActive } = useContext(SidebarThreadReorderContext);
  const resolvedContainerId = containerId ?? getLegacySidebarThreadContainerId(controller);
  const resolvedThreadId = threadId === undefined ? threadKey : threadId;
  const selfPolicy = resolveSidebarThreadDropPolicy({
    homeContainerId: null,
    sourceContainerId: resolvedContainerId,
    sourceProjectKind,
    targetContainerId: resolvedContainerId,
    targetProjectKind,
    threadId: resolvedThreadId,
    threadKind: sourceProjectKind === "remote" ? "remote" : "local",
  });
  const sortableDisabled = disabled || selfPolicy.status === "blocked";
  const payload = useMemo<SidebarThreadItemDndPayload>(
    () => ({
      kind: "sidebar-item",
      controller,
      itemId,
      itemIds,
      nextItemId,
      thread: {
        containerId: resolvedContainerId,
        dragOverlay: dragOverlay ?? children,
        getNextThreadId,
        getNextThreadKey,
        getPreviousThreadId,
        nextThreadKey,
        sourceProjectKind,
        targetProjectKind,
        threadId: resolvedThreadId,
        threadKey,
      },
    }),
    [
      children,
      controller,
      dragOverlay,
      getNextThreadId,
      getNextThreadKey,
      getPreviousThreadId,
      itemId,
      itemIds,
      nextItemId,
      nextThreadKey,
      resolvedContainerId,
      resolvedThreadId,
      sourceProjectKind,
      targetProjectKind,
      threadKey,
    ],
  );
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
    animateLayoutChanges: disableSidebarThreadLayoutAnimation,
    id: sortableId ?? threadKey,
    disabled: sortableDisabled,
    data: payload,
  });
  const activeDrag = isDragging || activeThreadKey === threadKey;
  const style: CSSProperties = {
    transform: CSS.Translate.toString(dragActive ? null : transform),
  };

  return (
    <div
      ref={setNodeRef}
      className={cn(className, activeDrag && "opacity-20", dragActive && "pointer-events-none")}
      style={style}
      inert={activeDrag ? true : undefined}
      role="listitem"
    >
      <div
        key={activeDrag ? "dragging" : "idle"}
        className={cn(
          sortableDisabled ? "cursor-interaction" : "cursor-grab active:cursor-grabbing",
        )}
        {...attributes}
        {...listeners}
      >
        {children}
      </div>
    </div>
  );
}

export function SidebarThreadDropIndicator() {
  return <SidebarDropIndicator />;
}

export function SidebarThreadReorderRows({
  containerId,
  getItemId,
  getThreadId,
  itemIds,
  visibleThreadKeys,
  sortableThreadKeys,
  onVisibleThreadOrderChange,
  renderThread,
  renderDragOverlay,
  sourceProjectKind,
  targetProjectKind,
}: {
  containerId?: string;
  getItemId?: (threadKey: string) => string | undefined;
  getThreadId?: (threadKey: string) => string | null;
  itemIds?: string[];
  visibleThreadKeys: string[];
  sortableThreadKeys: string[];
  onVisibleThreadOrderChange: (change: {
    visibleThreadKeys: string[];
    nextVisibleThreadKeys: string[];
  }) => Promise<void>;
  renderThread: (threadKey: string) => ReactNode;
  renderDragOverlay?: (threadKey: string) => ReactNode;
  sourceProjectKind?: SidebarThreadProjectKind;
  targetProjectKind?: SidebarThreadProjectKind;
}) {
  const reorder = useSidebarThreadReorderController({
    visibleThreadKeys: sortableThreadKeys,
    onVisibleThreadOrderChange,
  });
  const displayedThreadKeys = replaceVisibleCodexSidebarThreadKeyOrder({
    threadKeysInDisplayOrder: visibleThreadKeys,
    visibleThreadKeys: sortableThreadKeys,
    nextVisibleThreadKeys: reorder.displayedVisibleThreadKeys,
  });

  return (
    <SidebarThreadSortableRows
      containerId={containerId}
      getItemId={getItemId}
      getThreadId={getThreadId}
      itemIds={itemIds}
      visibleThreadKeys={displayedThreadKeys}
      sortableThreadKeysInDisplayOrder={reorder.displayedVisibleThreadKeys}
      controller={reorder.controller}
      dropIndicatorTarget={reorder.dropIndicatorTarget}
      renderThread={renderThread}
      renderDragOverlay={renderDragOverlay}
      sourceProjectKind={sourceProjectKind}
      targetProjectKind={targetProjectKind}
    />
  );
}

export function SidebarThreadSortableRows({
  containerId,
  getItemId,
  getThreadId = DEFAULT_GET_THREAD_ID,
  itemIds,
  visibleThreadKeys,
  sortableThreadKeysInDisplayOrder,
  controller,
  dropIndicatorTarget,
  renderThread,
  renderDragOverlay,
  sourceProjectKind,
  targetProjectKind,
}: {
  containerId?: string;
  getItemId?: (threadKey: string) => string | undefined;
  getThreadId?: (threadKey: string) => string | null;
  itemIds?: string[];
  visibleThreadKeys: string[];
  sortableThreadKeysInDisplayOrder: string[];
  controller: SidebarThreadReorderController;
  dropIndicatorTarget: SidebarThreadDropTarget | null;
  renderThread: (threadKey: string) => ReactNode;
  renderDragOverlay?: (threadKey: string) => ReactNode;
  sourceProjectKind?: SidebarThreadProjectKind;
  targetProjectKind?: SidebarThreadProjectKind;
}) {
  const sortableThreadKeySet = useMemo(
    () => new Set(sortableThreadKeysInDisplayOrder),
    [sortableThreadKeysInDisplayOrder],
  );
  const visibleSortableThreadKeys = visibleThreadKeys.filter((threadKey) =>
    sortableThreadKeySet.has(threadKey),
  );
  const lastVisibleSortableThreadKey = visibleSortableThreadKeys.at(-1) ?? null;
  const trailingIndicatorVisible =
    dropIndicatorTarget !== null &&
    (dropIndicatorTarget.beforeThreadKey === null ||
      !visibleThreadKeys.includes(dropIndicatorTarget.beforeThreadKey));

  return (
    <SidebarThreadSortableContext threadKeys={sortableThreadKeysInDisplayOrder}>
      {visibleThreadKeys.map((threadKey) => {
        if (!sortableThreadKeySet.has(threadKey)) {
          return <Fragment key={threadKey}>{renderThread(threadKey)}</Fragment>;
        }

        const sortableIndex = sortableThreadKeysInDisplayOrder.indexOf(threadKey);
        const nextRealThreadKey =
          sortableThreadKeysInDisplayOrder
            .slice(sortableIndex + 1)
            .find((candidateThreadKey) => getThreadId(candidateThreadKey) !== null) ?? null;
        const previousRealThreadKey =
          sortableThreadKeysInDisplayOrder
            .slice(0, sortableIndex)
            .findLast((candidateThreadKey) => getThreadId(candidateThreadKey) !== null) ?? null;
        const itemId = getItemId?.(threadKey);
        const itemIndex = itemId === undefined ? -1 : (itemIds?.indexOf(itemId) ?? -1);
        const nextItemId = itemIndex < 0 ? undefined : (itemIds?.[itemIndex + 1] ?? null);

        return (
          <Fragment key={threadKey}>
            {dropIndicatorTarget?.beforeThreadKey === threadKey ? (
              <SidebarThreadDropIndicator />
            ) : null}
            <SidebarThreadSortableItem
              containerId={containerId}
              threadKey={threadKey}
              threadId={getThreadId(threadKey)}
              controller={controller}
              dragOverlay={renderDragOverlay?.(threadKey)}
              getNextThreadId={() => resolveTargetThreadId(nextRealThreadKey, getThreadId)}
              getNextThreadKey={() => nextRealThreadKey}
              getPreviousThreadId={() => resolveTargetThreadId(previousRealThreadKey, getThreadId)}
              itemId={itemId}
              itemIds={itemIds}
              nextItemId={nextItemId}
              sourceProjectKind={sourceProjectKind}
              targetProjectKind={targetProjectKind}
            >
              {renderThread(threadKey)}
            </SidebarThreadSortableItem>
            {trailingIndicatorVisible && lastVisibleSortableThreadKey === threadKey ? (
              <SidebarThreadDropIndicator />
            ) : null}
          </Fragment>
        );
      })}
    </SidebarThreadSortableContext>
  );
}
