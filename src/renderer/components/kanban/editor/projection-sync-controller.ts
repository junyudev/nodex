import { EDITOR_SYNC_DEBOUNCE_MS } from "../../../lib/timing";
import type { CardInput, MoveCardInput } from "../../../lib/types";
import type { ToggleListCard } from "../../../lib/toggle-list/types";
import {
  buildProjectedChildren,
  collectProjectedCardPatchesForOwner,
  isProjectedCardMoveDirty,
  isProjectionMutationActive,
  pickProjectedCardFieldUpdates,
  runWithProjectionMutation,
  serializeProjectionRows,
  splitEmbedChildren,
  type ProjectedCardPatch,
} from "./projection-card-toggle";

interface ProjectionRuntimeBlock {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
  children?: unknown[];
}

interface ProjectionCursorPosition {
  block?: {
    id?: string;
  };
}

interface ProjectionRuntimeEditor {
  getBlock: (id: string) => ProjectionRuntimeBlock | undefined;
  getParentBlock?: (id: string) => ProjectionRuntimeBlock | undefined;
  getTextCursorPosition?: () => ProjectionCursorPosition | undefined;
  updateBlock: (id: string, update: { children: unknown[] }) => void;
  onChange: (listener: () => void) => () => void;
  onSelectionChange?: (listener: () => void) => () => void;
  domElement?: ParentNode;
}

interface PendingInboundReconcile {
  projectedRows: unknown[];
  projectedRowsSignature: string;
}

type OwnerCard = Pick<
ToggleListCard,
  "id" | "columnId" | "title" | "description" | "priority" | "estimate" | "tags"
>;
type OwnerCardMap = ReadonlyMap<string, OwnerCard>;

type ProjectionUpdateCard = (
  columnId: string,
  cardId: string,
  updates: Partial<CardInput>,
) => Promise<unknown>;

type ProjectionPatchCard = (
  columnId: string,
  cardId: string,
  updates: Partial<CardInput>,
) => void;

type ProjectionMoveCard = (input: MoveCardInput) => Promise<boolean>;

export interface ProjectionSyncOwnerInput {
  ownerBlockId: string;
  enabled: boolean;
  projectedRows: unknown[];
  projectedRowsSignature: string;
  cardById: OwnerCardMap;
  updateCard: ProjectionUpdateCard;
  patchCard: ProjectionPatchCard;
  moveCard: ProjectionMoveCard;
}

interface ProjectionSyncOwnerState extends ProjectionSyncOwnerInput {
  hasFocusWithin: boolean;
  pendingInboundReconcile: PendingInboundReconcile | null;
  pendingPatchByCardId: Map<string, ProjectedCardPatch>;
  inFlightCardIds: Set<string>;
  syncTimer: ReturnType<typeof setTimeout> | null;
  flushInProgress: boolean;
  flushRequested: boolean;
}

let projectionSyncControllers = new WeakMap<object, ProjectionSyncController>();

function runInMicrotask(task: () => void): void {
  if (typeof queueMicrotask === "function") {
    queueMicrotask(task);
    return;
  }

  void Promise.resolve().then(task);
}

function supportsProjectionRuntimeEditor(value: unknown): value is ProjectionRuntimeEditor {
  if (typeof value !== "object" || value === null) return false;
  const runtime = value as Partial<ProjectionRuntimeEditor>;
  if (typeof runtime.getBlock !== "function") return false;
  if (typeof runtime.updateBlock !== "function") return false;
  return typeof runtime.onChange === "function";
}

function supportsSelectionTrackingEditor(value: unknown): value is Required<Pick<
ProjectionRuntimeEditor,
  "getParentBlock" | "getTextCursorPosition" | "onSelectionChange"
>> & ProjectionRuntimeEditor {
  if (!supportsProjectionRuntimeEditor(value)) return false;
  if (typeof value.getParentBlock !== "function") return false;
  if (typeof value.getTextCursorPosition !== "function") return false;
  return typeof value.onSelectionChange === "function";
}

function resolveEditorContainer(editor: ProjectionRuntimeEditor): HTMLElement | undefined {
  if (!(editor.domElement instanceof Element)) return undefined;
  const container = editor.domElement.closest(".nfm-editor");
  return container instanceof HTMLElement ? container : undefined;
}

function isProjectedPatchDirty(
  patch: ProjectedCardPatch,
  card: OwnerCard,
): boolean {
  if (Object.keys(pickProjectedCardFieldUpdates(patch, card)).length > 0) {
    return true;
  }

  return isProjectedCardMoveDirty(patch, card);
}

function isSameProjectedPatch(a: ProjectedCardPatch, b: ProjectedCardPatch): boolean {
  const comparableKeys: Array<keyof CardInput> = [
    "title",
    "description",
    "priority",
    "estimate",
    "tags",
  ];

  for (const key of comparableKeys) {
    const left = a.updates[key];
    const right = b.updates[key];
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right)) return false;
      if (left.length !== right.length) return false;
      for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return false;
      }
      continue;
    }
    if (left !== right) return false;
  }

  return a.cardId === b.cardId
    && a.sourceProjectId === b.sourceProjectId
    && a.targetColumnId === b.targetColumnId;
}

function mergeProjectedPatchesIntoPending(
  pendingPatches: Map<string, ProjectedCardPatch>,
  nextPatches: ProjectedCardPatch[],
  cardById: OwnerCardMap,
): void {
  for (const patch of nextPatches) {
    const card = cardById.get(patch.cardId);
    if (!card) {
      pendingPatches.delete(patch.cardId);
      continue;
    }

    if (!isProjectedPatchDirty(patch, card)) {
      pendingPatches.delete(patch.cardId);
      continue;
    }

    pendingPatches.set(patch.cardId, patch);
  }
}

function getReadyProjectedPatches(
  pendingPatches: ReadonlyMap<string, ProjectedCardPatch>,
  inFlightCardIds: ReadonlySet<string>,
): ProjectedCardPatch[] {
  const ready: ProjectedCardPatch[] = [];

  for (const [cardId, patch] of pendingPatches) {
    if (inFlightCardIds.has(cardId)) continue;
    ready.push(patch);
  }

  return ready;
}

class ProjectionSyncController {
  private readonly owners = new Map<string, ProjectionSyncOwnerState>();

  private unsubscribeEditorChange: (() => void) | null = null;

  private unsubscribeSelectionChange: (() => void) | null = null;

  private container: HTMLElement | undefined;

  private observer: MutationObserver | null = null;

  private focusedOwnerId: string | null = null;

  upsertOwner(input: ProjectionSyncOwnerInput): void {
    const owner = this.owners.get(input.ownerBlockId) ?? this.createOwner(input);

    owner.enabled = input.enabled;
    owner.projectedRows = input.projectedRows;
    owner.projectedRowsSignature = input.projectedRowsSignature;
    owner.cardById = input.cardById;
    owner.updateCard = input.updateCard;
    owner.patchCard = input.patchCard;
    owner.moveCard = input.moveCard;

    this.owners.set(input.ownerBlockId, owner);
    this.ensureBindings();
    this.applyInboundReconcile(owner, input.projectedRows, input.projectedRowsSignature);
  }

  removeOwner(ownerBlockId: string): void {
    const owner = this.owners.get(ownerBlockId);
    if (!owner) return;

    if (owner.syncTimer) {
      clearTimeout(owner.syncTimer);
      owner.syncTimer = null;
    }
    owner.pendingPatchByCardId.clear();
    owner.inFlightCardIds.clear();
    owner.pendingInboundReconcile = null;
    owner.hasFocusWithin = false;
    owner.flushRequested = false;
    owner.flushInProgress = false;

    this.owners.delete(ownerBlockId);
    if (this.focusedOwnerId === ownerBlockId) {
      this.focusedOwnerId = null;
    }

    if (this.owners.size === 0) {
      this.teardownBindings();
    }
  }

  isEmpty(): boolean {
    return this.owners.size === 0;
  }

  destroy(): void {
    this.teardownBindings();
    for (const owner of this.owners.values()) {
      if (owner.syncTimer) {
        clearTimeout(owner.syncTimer);
        owner.syncTimer = null;
      }
      owner.pendingPatchByCardId.clear();
      owner.inFlightCardIds.clear();
    }
    this.owners.clear();
    this.focusedOwnerId = null;
  }

  constructor(private readonly editor: ProjectionRuntimeEditor) {}

  private createOwner(input: ProjectionSyncOwnerInput): ProjectionSyncOwnerState {
    return {
      ...input,
      hasFocusWithin: false,
      pendingInboundReconcile: null,
      pendingPatchByCardId: new Map(),
      inFlightCardIds: new Set(),
      syncTimer: null,
      flushInProgress: false,
      flushRequested: false,
    };
  }

  private ensureBindings(): void {
    if (this.unsubscribeEditorChange) return;

    this.unsubscribeEditorChange = this.editor.onChange(() => {
      if (isProjectionMutationActive()) return;

      const focusedOwnerId = this.focusedOwnerId;
      if (focusedOwnerId && this.owners.has(focusedOwnerId)) {
        this.capturePendingPatchesForOwner(focusedOwnerId);
        this.scheduleOwnerFlush(focusedOwnerId);
        return;
      }

      for (const owner of this.owners.values()) {
        if (!owner.enabled) continue;
        this.capturePendingPatchesForOwner(owner.ownerBlockId);
        this.scheduleOwnerFlush(owner.ownerBlockId);
      }
    });

    if (supportsSelectionTrackingEditor(this.editor)) {
      this.unsubscribeSelectionChange = this.editor.onSelectionChange(() => {
        this.handleSelectionChange();
      });
      this.handleSelectionChange();
    }

    this.container = resolveEditorContainer(this.editor);
    if (!this.container) return;

    this.container.addEventListener("focusout", this.handleContainerFocusOut);

    if (typeof MutationObserver !== "function") return;
    this.observer = new MutationObserver((mutations) => {
      if (isProjectionMutationActive()) return;

      for (const mutation of mutations) {
        if (
          mutation.type !== "attributes"
          || mutation.attributeName !== "data-show-children"
          || !(mutation.target instanceof HTMLElement)
          || !mutation.target.classList.contains("bn-toggle-wrapper")
        ) {
          continue;
        }

        const blockElement = mutation.target.closest(".bn-block[data-id]");
        const blockId = blockElement instanceof HTMLElement
          ? blockElement.getAttribute("data-id")
          : null;

        const targetedOwnerId = typeof blockId === "string" && blockId.length > 0
          ? this.resolveOwnerForBlockId(blockId)
          : this.focusedOwnerId;

        if (targetedOwnerId) {
          this.scheduleOwnerFlush(targetedOwnerId, true);
          return;
        }

        for (const owner of this.owners.values()) {
          if (!owner.enabled) continue;
          this.scheduleOwnerFlush(owner.ownerBlockId, true);
        }
        return;
      }
    });

    this.observer.observe(this.container, {
      attributes: true,
      attributeFilter: ["data-show-children"],
      subtree: true,
    });
  }

  private teardownBindings(): void {
    if (this.unsubscribeEditorChange) {
      this.unsubscribeEditorChange();
      this.unsubscribeEditorChange = null;
    }

    if (this.unsubscribeSelectionChange) {
      this.unsubscribeSelectionChange();
      this.unsubscribeSelectionChange = null;
    }

    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }

    if (this.container) {
      this.container.removeEventListener("focusout", this.handleContainerFocusOut);
      this.container = undefined;
    }
  }

  private readonly handleContainerFocusOut = (event: FocusEvent): void => {
    if (!this.container) return;

    const nextTarget = event.relatedTarget as Node | null;
    if (nextTarget && this.container.contains(nextTarget)) return;
    if (isProjectionMutationActive()) return;

    this.focusedOwnerId = null;
    for (const owner of this.owners.values()) {
      owner.hasFocusWithin = false;
      this.applyPendingInboundReconcile(owner);
      this.scheduleOwnerFlush(owner.ownerBlockId, true);
    }
  };

  private handleSelectionChange(): void {
    const previousFocusedOwnerId = this.focusedOwnerId;
    const nextFocusedOwnerId = this.resolveFocusedOwnerId();
    this.focusedOwnerId = nextFocusedOwnerId;

    for (const owner of this.owners.values()) {
      owner.hasFocusWithin = owner.ownerBlockId === nextFocusedOwnerId;
    }

    if (
      previousFocusedOwnerId
      && previousFocusedOwnerId !== nextFocusedOwnerId
    ) {
      const previousOwner = this.owners.get(previousFocusedOwnerId);
      if (previousOwner) {
        this.applyPendingInboundReconcile(previousOwner);
        this.scheduleOwnerFlush(previousFocusedOwnerId, true);
      }
    }
  }

  private resolveFocusedOwnerId(): string | null {
    if (!supportsSelectionTrackingEditor(this.editor)) return null;

    const cursor = this.editor.getTextCursorPosition();
    const cursorBlockId = cursor?.block?.id;
    if (typeof cursorBlockId !== "string" || cursorBlockId.length === 0) {
      return null;
    }

    return this.resolveOwnerForBlockId(cursorBlockId);
  }

  private resolveOwnerForBlockId(blockId: string): string | null {
    if (typeof this.editor.getParentBlock !== "function") return null;

    const visited = new Set<string>();
    let currentId: string | undefined = blockId;

    while (typeof currentId === "string" && currentId.length > 0) {
      if (this.owners.has(currentId)) {
        return currentId;
      }
      if (visited.has(currentId)) return null;

      visited.add(currentId);
      const parent = this.editor.getParentBlock(currentId);
      currentId = typeof parent?.id === "string" ? parent.id : undefined;
    }

    return null;
  }

  private capturePendingPatchesForOwner(ownerBlockId: string): void {
    const owner = this.owners.get(ownerBlockId);
    if (!owner || !owner.enabled) return;

    const ownerBlock = this.editor.getBlock(owner.ownerBlockId);
    if (!ownerBlock || !Array.isArray(ownerBlock.children)) return;

    const currentPatches = collectProjectedCardPatchesForOwner(
      ownerBlock.children,
      owner.ownerBlockId,
      this.container ?? resolveEditorContainer(this.editor),
    );

    mergeProjectedPatchesIntoPending(
      owner.pendingPatchByCardId,
      currentPatches,
      owner.cardById,
    );
  }

  private scheduleOwnerFlush(ownerBlockId: string, immediate = false): void {
    const owner = this.owners.get(ownerBlockId);
    if (!owner || !owner.enabled) return;

    if (owner.syncTimer) {
      clearTimeout(owner.syncTimer);
      owner.syncTimer = null;
    }

    if (immediate) {
      void this.flushOwner(ownerBlockId);
      return;
    }

    owner.syncTimer = setTimeout(() => {
      owner.syncTimer = null;
      void this.flushOwner(ownerBlockId);
    }, EDITOR_SYNC_DEBOUNCE_MS);
  }

  private applyInboundReconcile(
    owner: ProjectionSyncOwnerState,
    nextProjectedRows: unknown[],
    nextProjectedRowsSignature: string,
  ): void {
    runInMicrotask(() => {
      if (!this.owners.has(owner.ownerBlockId)) return;

      const outboundBusy = owner.flushInProgress
        || owner.inFlightCardIds.size > 0
        || owner.pendingPatchByCardId.size > 0;
      if (owner.hasFocusWithin || outboundBusy) {
        owner.pendingInboundReconcile = {
          projectedRows: nextProjectedRows,
          projectedRowsSignature: nextProjectedRowsSignature,
        };
        if (!owner.flushInProgress && owner.pendingPatchByCardId.size > 0) {
          this.scheduleOwnerFlush(owner.ownerBlockId, true);
        }
        return;
      }

      const ownerBlock = this.editor.getBlock(owner.ownerBlockId);
      if (!ownerBlock) return;

      const currentChildren = Array.isArray(ownerBlock.children)
        ? ownerBlock.children
        : [];

      const currentSplit = splitEmbedChildren(currentChildren, owner.ownerBlockId);
      const currentSignature = serializeProjectionRows(currentSplit.projectedRows);
      if (currentSignature === nextProjectedRowsSignature) return;

      const nextChildren = buildProjectedChildren(
        owner.ownerBlockId,
        nextProjectedRows,
        currentChildren,
      );

      runWithProjectionMutation(() => {
        this.editor.updateBlock(owner.ownerBlockId, { children: nextChildren });
      });
    });
  }

  private applyPendingInboundReconcile(owner: ProjectionSyncOwnerState): void {
    const pending = owner.pendingInboundReconcile;
    if (!pending) return;

    owner.pendingInboundReconcile = null;
    this.applyInboundReconcile(owner, pending.projectedRows, pending.projectedRowsSignature);
  }

  private async flushOwner(ownerBlockId: string): Promise<void> {
    const owner = this.owners.get(ownerBlockId);
    if (!owner || !owner.enabled) return;
    if (isProjectionMutationActive()) return;

    if (owner.flushInProgress) {
      owner.flushRequested = true;
      return;
    }

    owner.flushInProgress = true;

    try {
      let sentAnyOutboundPatch = false;

      while (true) {
        owner.flushRequested = false;

        const ownerBlock = this.editor.getBlock(owner.ownerBlockId);
        if (ownerBlock && Array.isArray(ownerBlock.children)) {
          const currentPatches = collectProjectedCardPatchesForOwner(
            ownerBlock.children,
            owner.ownerBlockId,
            this.container ?? resolveEditorContainer(this.editor),
          );

          mergeProjectedPatchesIntoPending(
            owner.pendingPatchByCardId,
            currentPatches,
            owner.cardById,
          );
        }

        const readyPatches = getReadyProjectedPatches(
          owner.pendingPatchByCardId,
          owner.inFlightCardIds,
        );

        if (readyPatches.length === 0) {
          if (!owner.flushRequested) break;
          continue;
        }

        let hadSendFailure = false;

        await Promise.all(
          readyPatches.map(async (patch) => {
            const card = owner.cardById.get(patch.cardId);
            if (!card) {
              owner.pendingPatchByCardId.delete(patch.cardId);
              return;
            }

            let sendFailed = false;
            owner.inFlightCardIds.add(patch.cardId);
            try {
                const updates = pickProjectedCardFieldUpdates(patch, card);
                if (Object.keys(updates).length > 0) {
                  owner.patchCard(card.columnId, card.id, updates);
                  const updateResult = await owner.updateCard(card.columnId, card.id, updates) as
                    | { status?: string }
                    | null;
                  if (!updateResult || updateResult.status !== "updated") {
                    sendFailed = true;
                    hadSendFailure = true;
                  } else {
                  sentAnyOutboundPatch = true;
                }
              }

              if (!sendFailed && isProjectedCardMoveDirty(patch, card) && patch.targetColumnId) {
                const moved = await owner.moveCard({
                  cardId: card.id,
                  fromColumnId: card.columnId,
                  toColumnId: patch.targetColumnId,
                });

                if (!moved) {
                  sendFailed = true;
                  hadSendFailure = true;
                } else {
                  sentAnyOutboundPatch = true;
                }
              }
            } catch {
              sendFailed = true;
              hadSendFailure = true;
            } finally {
              owner.inFlightCardIds.delete(patch.cardId);

              if (!sendFailed) {
                const latest = owner.pendingPatchByCardId.get(patch.cardId);
                if (latest && isSameProjectedPatch(latest, patch)) {
                  owner.pendingPatchByCardId.delete(patch.cardId);
                }
              }

              if (owner.pendingPatchByCardId.has(patch.cardId)) {
                owner.flushRequested = true;
              }
            }
          }),
        );

        if (hadSendFailure) {
          break;
        }

        if (owner.flushRequested) {
          continue;
        }

        const remainingReady = getReadyProjectedPatches(
          owner.pendingPatchByCardId,
          owner.inFlightCardIds,
        );
        if (remainingReady.length === 0) {
          break;
        }
      }

      if (sentAnyOutboundPatch) {
        // Inbound snapshots queued while outbound was dirty are usually stale.
        // Drop them and wait for fresh board-projected rows from the next upsert.
        owner.pendingInboundReconcile = null;
      }
    } finally {
      owner.flushInProgress = false;
      const canApplyPendingInbound = !owner.hasFocusWithin
        && owner.inFlightCardIds.size === 0
        && owner.pendingPatchByCardId.size === 0;
      if (canApplyPendingInbound && owner.pendingInboundReconcile) {
        this.applyPendingInboundReconcile(owner);
      }
    }
  }
}

export function upsertProjectionSyncOwner(
  editor: unknown,
  input: ProjectionSyncOwnerInput,
): void {
  if (!supportsProjectionRuntimeEditor(editor)) return;

  const key = editor as object;
  const controller = projectionSyncControllers.get(key) ?? new ProjectionSyncController(editor);
  projectionSyncControllers.set(key, controller);
  controller.upsertOwner(input);
}

export function removeProjectionSyncOwner(
  editor: unknown,
  ownerBlockId: string,
): void {
  if (typeof editor !== "object" || editor === null) return;

  const controller = projectionSyncControllers.get(editor);
  if (!controller) return;

  controller.removeOwner(ownerBlockId);
  if (!controller.isEmpty()) return;

  controller.destroy();
  projectionSyncControllers.delete(editor);
}

export function resetProjectionSyncControllersForTest(): void {
  projectionSyncControllers = new WeakMap<object, ProjectionSyncController>();
}
