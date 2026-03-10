import {
  getElementFromTarget,
  hasClosest,
  resolveDraggedBlockIds,
} from "./drag-source-resolver";
import { finalizeSideMenuBlockDrag } from "./side-menu-drag-lifecycle";

// ---------- Minimal editor interface (same pattern as toggle-shortcut.ts) ----------

interface Block {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content: unknown;
  children: Block[];
}

interface EditorForToggleDrop {
  domElement?: ParentNode;
  prosemirrorView?: {
    state: {
      selection: object;
    };
    dragging?: unknown;
  };
  getExtension?: (extension: unknown) => unknown;
  getBlock(id: string): Block | undefined;
  getSelection(): { blocks: Block[] } | undefined;
  getParentBlock(id: string): Block | undefined;
  removeBlocks(ids: string[]): void;
  insertBlocks(
    blocks: unknown[],
    refId: string,
    placement: "before" | "after",
  ): void;
  replaceBlocks(toRemove: string[], replacements: unknown[]): void;
  transact<T>(fn: () => T): T;
}

interface ToggleDropTargetBlock {
  type: string;
  props?: Record<string, unknown>;
}

/** Vertical inset (px) at top/bottom of toggle header that is reserved for
 *  ProseMirror's normal "insert between blocks" drop indicator.  Only the
 *  center band activates toggle-drop ("drop into collapsed toggle"). */
const TOGGLE_DROP_EDGE_INSET_PX = 6;

// ---------- DOM helpers ----------

/**
 * Walk up from an event target to find the `.bn-block-outer` element of a
 * **collapsed** toggle header — but only when the target is over the header
 * area (the `.bn-block-content`), not over the children `.bn-block-group`.
 * Returns null for open toggles (normal DnD handles those).
 */

function getClosestBlockOuter(target: EventTarget | null): HTMLElement | null {
  const el = getElementFromTarget(target);
  if (!el) return null;
  return el.closest<HTMLElement>(".bn-block-outer");
}

export function findToggleOuterFromTarget(
  target: EventTarget | null,
): HTMLElement | null {
  const el = getElementFromTarget(target);
  if (!el) return null;

  // Must be inside a toggle block-content (toggleListItem or toggle heading)
  const toggleWrapper = el.closest<HTMLElement>(".bn-toggle-wrapper");
  if (!toggleWrapper) return null;
  const blockContent = toggleWrapper.closest<HTMLElement>(".bn-block-content");
  if (!blockContent) return null;

  // Reject if we're inside a nested block-group (i.e. the children area)
  const closestBlockGroup = el.closest<HTMLElement>(".bn-block-group");
  let blockOuter = blockContent.closest<HTMLElement>(".bn-block-outer");
  if (!blockOuter) return null;

  // If the nearest block-group is *inside* this block-outer, the cursor is in
  // the children area, not the header.  The header's block-content is a direct
  // child of .bn-block which is a direct child of .bn-block-outer.  If the
  // nearest .bn-block-group is between the target and the block-outer, skip.
  if (closestBlockGroup && blockOuter.contains(closestBlockGroup)) {
    // Check whether blockContent is *inside* that block-group — if so, we're
    // in a child block's toggle, not the top-level one.
    if (closestBlockGroup.contains(blockContent)) {
      // blockContent is inside a child block-group, so the outermost
      // .bn-block-outer we found is the parent.  Re-derive for THIS toggle.
      blockOuter = blockContent.closest<HTMLElement>(".bn-block-outer");
      if (!blockOuter) return null;
    }
  }

  // Only activate on collapsed toggles — open toggles use normal DnD
  if (!isToggleCollapsed(blockOuter)) return null;

  return blockOuter;
}

function isPointInsideElement(
  el: HTMLElement,
  clientX: number,
  clientY: number,
): boolean {
  const rect = el.getBoundingClientRect();
  return (
    clientX >= rect.left
    && clientX <= rect.right
    && clientY >= rect.top
    && clientY <= rect.bottom
  );
}

function isPointInToggleHeaderBand(
  outerEl: HTMLElement,
  clientX: number,
  clientY: number,
): boolean {
  // Find block-content that contains a toggle wrapper (works for both toggleListItem and toggle heading)
  const wrapper = outerEl.querySelector<HTMLElement>(".bn-toggle-wrapper");
  const blockContent = wrapper?.closest<HTMLElement>(".bn-block-content");
  if (!blockContent) return false;

  const rect = blockContent.getBoundingClientRect();
  const sideMenuAllowancePx = 56;

  return (
    clientY >= rect.top + TOGGLE_DROP_EDGE_INSET_PX
    && clientY <= rect.bottom - TOGGLE_DROP_EDGE_INSET_PX
    && clientX >= rect.left - sideMenuAllowancePx
    && clientX <= rect.right
  );
}

function findCollapsedToggleOuterFromOuterElement(
  outerEl: HTMLElement,
  clientX: number,
  clientY: number,
): HTMLElement | null {
  if (!isToggleCollapsed(outerEl)) return null;
  if (!isPointInToggleHeaderBand(outerEl, clientX, clientY)) return null;
  return outerEl;
}

export function findToggleOuterFromPoint(
  container: HTMLElement,
  clientX: number,
  clientY: number,
): HTMLElement | null {
  const elements = container.ownerDocument.elementsFromPoint(clientX, clientY);
  for (const element of elements) {
    if (!hasClosest(element)) continue;
    if (!container.contains(element)) continue;
    const toggleOuter = findToggleOuterFromTarget(element);
    if (toggleOuter && isPointInToggleHeaderBand(toggleOuter, clientX, clientY)) {
      return toggleOuter;
    }

    const closestOuter = getClosestBlockOuter(element);
    if (!closestOuter) continue;

    const collapsedFromOuter = findCollapsedToggleOuterFromOuterElement(
      closestOuter,
      clientX,
      clientY,
    );
    if (collapsedFromOuter) return collapsedFromOuter;
  }
  return null;
}

function getBlockIdFromOuter(outerEl: HTMLElement): string | null {
  return (
    outerEl.querySelector<HTMLElement>(".bn-block[data-id]")?.getAttribute(
      "data-id",
    ) ?? null
  );
}

function isToggleCollapsed(outerEl: HTMLElement): boolean {
  const wrapper = outerEl.querySelector<HTMLElement>(".bn-toggle-wrapper");
  return wrapper?.getAttribute("data-show-children") === "false";
}

// ---------- Block logic ----------

export function isToggleDropTargetBlock(block: ToggleDropTargetBlock): boolean {
  if (block.type === "toggleListItem") return true;
  if (block.type === "cardToggle") return true;
  return block.type === "heading" && block.props?.isToggleable === true;
}

/** Returns true if `possibleDescendantId` is a descendant of `possibleAncestorId`. */
function isDescendant(
  editor: EditorForToggleDrop,
  possibleDescendantId: string,
  possibleAncestorId: string,
): boolean {
  let current = editor.getParentBlock(possibleDescendantId);
  while (current) {
    if (current.id === possibleAncestorId) return true;
    current = editor.getParentBlock(current.id);
  }
  return false;
}

/**
 * Move `draggedIds` blocks into `toggleBlockId`'s children (appended at end).
 * Returns true if the move was performed.
 */
function moveBlocksIntoToggle(
  editor: EditorForToggleDrop,
  draggedIds: string[],
  toggleBlockId: string,
): boolean {
  // Guard: can't drop a block onto itself
  if (draggedIds.includes(toggleBlockId)) return false;

  const toggle = editor.getBlock(toggleBlockId);
  if (!toggle) return false;
  if (!isToggleDropTargetBlock(toggle)) return false;

  // Guard: circular nesting — if the toggle is a descendant of any dragged block
  for (const id of draggedIds) {
    if (isDescendant(editor, toggleBlockId, id)) return false;
  }

  // Guard: all blocks are already direct children
  const childIds = new Set(toggle.children.map((c) => c.id));
  if (draggedIds.every((id) => childIds.has(id))) return false;

  // Snapshot dragged blocks before removal
  const draggedBlocks = draggedIds
    .map((id) => editor.getBlock(id))
    .filter((b): b is Block => b !== undefined);
  if (draggedBlocks.length === 0) return false;

  // Single transaction → single undo step
  editor.transact(() => {
    editor.removeBlocks(draggedIds);

    // Re-fetch toggle (positions shifted after removal)
    const updated = editor.getBlock(toggleBlockId);
    if (!updated) return;

    if (updated.children.length > 0) {
      const lastChild = updated.children[updated.children.length - 1];
      editor.insertBlocks(draggedBlocks, lastChild.id, "after");
    } else {
      editor.replaceBlocks([toggleBlockId], [
        {
          ...updated,
          children: draggedBlocks,
        },
      ]);
    }
  });

  return true;
}

// ---------- Visual cue helpers ----------

interface ActiveDropCue {
  outerEl: HTMLElement;
  overlayEl: HTMLDivElement;
  blockId: string;
}

function createDropOverlay(container: HTMLElement): HTMLDivElement {
  const overlayEl = container.ownerDocument.createElement("div");
  overlayEl.setAttribute("data-toggle-drop-overlay", "");
  overlayEl.setAttribute("aria-hidden", "true");
  return overlayEl;
}

/** Position overlay in container-space to cover the toggle header center zone
 *  (excluding the edge-inset strips reserved for "insert between" drops). */
function positionOverlay(
  overlayEl: HTMLDivElement,
  outerEl: HTMLElement,
  container: HTMLElement,
): void {
  const wrapper = outerEl.querySelector<HTMLElement>(".bn-toggle-wrapper");
  const blockContent = wrapper?.closest<HTMLElement>(".bn-block-content");
  const targetEl = blockContent ?? outerEl;
  const targetRect = targetEl.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  overlayEl.style.top = `${targetRect.top - containerRect.top + TOGGLE_DROP_EDGE_INSET_PX}px`;
  overlayEl.style.left = `${targetRect.left - containerRect.left}px`;
  overlayEl.style.width = `${targetRect.width}px`;
  overlayEl.style.height = `${Math.max(0, targetRect.height - 2 * TOGGLE_DROP_EDGE_INSET_PX)}px`;
}

function removeDropCue(cue: ActiveDropCue | null): void {
  if (!cue) return;
  cue.overlayEl.remove();
}

function setDropTarget(
  container: HTMLElement,
  outerEl: HTMLElement | null,
  prev: ActiveDropCue | null,
): ActiveDropCue | null {
  if (prev && prev.outerEl === outerEl) {
    if (!prev.overlayEl.isConnected) {
      container.append(prev.overlayEl);
    }
    positionOverlay(prev.overlayEl, prev.outerEl, container);
    return prev;
  }

  removeDropCue(prev);

  if (outerEl) {
    const blockId = getBlockIdFromOuter(outerEl) ?? "";
    const overlayEl = createDropOverlay(container);
    container.append(overlayEl);
    positionOverlay(overlayEl, outerEl, container);
    container.setAttribute("data-toggle-drop-active", "");
    return {
      outerEl,
      overlayEl,
      blockId,
    };
  } else {
    container.removeAttribute("data-toggle-drop-active");
    return null;
  }
}

function clearAllCues(
  container: HTMLElement,
  current: ActiveDropCue | null,
): null {
  removeDropCue(current);
  container.removeAttribute("data-toggle-drop-active");
  return null;
}

export function finalizeToggleDropDragSession(editor: EditorForToggleDrop): void {
  finalizeSideMenuBlockDrag(editor);
}

// ---------- Debug helpers ----------

const TOGGLE_DND_DEBUG_FLAG = "__TOGGLE_DND_DEBUG__";

type GlobalWithToggleDropDebug = typeof globalThis & {
  [TOGGLE_DND_DEBUG_FLAG]?: boolean;
};

function isToggleDropDebugEnabled(): boolean {
  return (globalThis as GlobalWithToggleDropDebug)[TOGGLE_DND_DEBUG_FLAG] === true;
}

function getEventTargetSummary(target: EventTarget | null): string {
  const el = getElementFromTarget(target);
  if (!el) return "none";
  const className = typeof (el as { className?: unknown }).className === "string"
    ? (el as { className: string }).className
    : "";
  return `${el.tagName.toLowerCase()}${className ? `.${className}` : ""}`;
}

function debugToggleDrop(event: string, details: Record<string, unknown>): void {
  if (!isToggleDropDebugEnabled()) return;
  console.debug("[toggle-drop]", event, details);
}

/**
 * If the stored outerEl has been detached by a ProseMirror DOM update,
 * re-resolve it from the blockId.  Returns the (possibly updated) cue,
 * or null if the block no longer exists / is no longer a collapsed toggle.
 */
function revalidateActiveTarget(
  container: HTMLElement,
  cue: ActiveDropCue,
): ActiveDropCue | null {
  if (cue.outerEl.isConnected) return cue;

  const blockEl = container.querySelector<HTMLElement>(
    `.bn-block[data-id="${CSS.escape(cue.blockId)}"]`,
  );
  const newOuter = blockEl?.closest<HTMLElement>(".bn-block-outer");
  if (!newOuter || !isToggleCollapsed(newOuter)) return null;

  // Migrate reference to the new DOM node (overlay stays in container)
  cue.outerEl = newOuter;
  return cue;
}

function resolveDropTarget(
  container: HTMLElement,
  event: DragEvent,
  activeTarget: ActiveDropCue | null,
): HTMLElement | null {
  const fromTarget = findToggleOuterFromTarget(event.target);
  if (fromTarget && isPointInToggleHeaderBand(fromTarget, event.clientX, event.clientY)) {
    return fromTarget;
  }

  const fromPoint = findToggleOuterFromPoint(container, event.clientX, event.clientY);
  if (fromPoint) return fromPoint;

  if (activeTarget) {
    const valid = revalidateActiveTarget(container, activeTarget);
    if (valid && isPointInsideElement(valid.outerEl, event.clientX, event.clientY)) {
      return valid.outerEl;
    }
  }

  return null;
}

export function isSyntheticDnDEvent(event: DragEvent): boolean {
  const maybeSynthetic = event as DragEvent & { synthetic?: unknown };
  return maybeSynthetic.synthetic === true || event.isTrusted === false;
}

// ---------- Main setup ----------

export function setupToggleDrop(
  container: HTMLElement,
  editor: EditorForToggleDrop,
): () => void {
  let dragActive = false;
  let dragSourceResolved = false;
  let draggedBlockIds: string[] = [];
  let activeTarget: ActiveDropCue | null = null;

  /** Lazily resolve dragged block IDs from authoritative signals.
   *  Called on first dragover/drop — by then BlockNote has dispatched
   *  NodeSelection / MultipleNodeSelection. */
  function resolveDragSource(): string[] {
    if (dragSourceResolved) return draggedBlockIds;
    dragSourceResolved = true;

    draggedBlockIds = resolveDraggedBlockIds(editor, container);
    if (draggedBlockIds.length > 0) {
      debugToggleDrop("resolve:shared", { draggedBlockIds });
      return draggedBlockIds;
    }

    // No authoritative signal → don't guess
    debugToggleDrop("resolve:none", {});
    return draggedBlockIds;
  }

  // --- dragstart: mark drag active, defer source identification ---
  const onDragStart = () => {
    dragActive = true;
    dragSourceResolved = false;
    draggedBlockIds = [];
    debugToggleDrop("dragstart:deferred", {});
  };

  // --- dragover: detect toggle header and show visual cue ---
  const onDragOver = (e: DragEvent) => {
    if (!dragActive) return;
    const ids = resolveDragSource();
    if (ids.length === 0) return;
    if (isSyntheticDnDEvent(e)) {
      debugToggleDrop("dragover:ignored-synthetic", {
        clientX: e.clientX,
        clientY: e.clientY,
        target: getEventTargetSummary(e.target),
      });
      return;
    }

    // Guard-first: keep current target if pointer is still over its header.
    // This prevents flicker caused by transient e.target changes or stale DOM
    // references after ProseMirror view updates.
    if (activeTarget) {
      const valid = revalidateActiveTarget(container, activeTarget);
      if (valid) {
        activeTarget = valid;
        if (isPointInToggleHeaderBand(valid.outerEl, e.clientX, e.clientY)) {
          if (!valid.overlayEl.isConnected) {
            container.append(valid.overlayEl);
          }
          positionOverlay(valid.overlayEl, valid.outerEl, container);
          debugToggleDrop("dragover:keep-target", {
            clientX: e.clientX,
            clientY: e.clientY,
          });
          return;
        }
      } else {
        // Block was removed or toggle opened — clear stale cue
        activeTarget = clearAllCues(container, activeTarget);
      }
    }

    // Try to find a (new) toggle target — gate DOM-based resolution with a
    // coordinate check so the top/bottom edges of the header are left for
    // ProseMirror's normal "insert between blocks" dropcursor.
    let toggleOuter = findToggleOuterFromTarget(e.target);
    if (toggleOuter && !isPointInToggleHeaderBand(toggleOuter, e.clientX, e.clientY)) {
      toggleOuter = null;
    }
    toggleOuter ??= findToggleOuterFromPoint(container, e.clientX, e.clientY);

    if (toggleOuter) {
      const blockId = getBlockIdFromOuter(toggleOuter);
      // Don't highlight if dragging the toggle itself or a parent
      if (blockId && !ids.includes(blockId)) {
        activeTarget = setDropTarget(container, toggleOuter, activeTarget);
        debugToggleDrop("dragover:set-target", {
          targetBlockId: blockId,
          clientX: e.clientX,
          clientY: e.clientY,
        });
        return;
      }
    }

    // Not over a valid toggle header — clear cue
    activeTarget = setDropTarget(container, null, activeTarget);
    debugToggleDrop("dragover:clear-target", {
      clientX: e.clientX,
      clientY: e.clientY,
      target: getEventTargetSummary(e.target),
    });
  };

  // --- drop (capture phase): intercept before ProseMirror ---
  const onDrop = (e: DragEvent) => {
    if (!dragActive) {
      debugToggleDrop("drop:skip-no-drag", {
        clientX: e.clientX,
        clientY: e.clientY,
      });
      return;
    }
    if (isSyntheticDnDEvent(e)) {
      debugToggleDrop("drop:ignored-synthetic", {
        clientX: e.clientX,
        clientY: e.clientY,
        target: getEventTargetSummary(e.target),
      });
      return;
    }

    const ids = resolveDragSource();
    if (ids.length === 0) {
      debugToggleDrop("drop:skip-no-source", {
        clientX: e.clientX,
        clientY: e.clientY,
      });
      return;
    }

    const toggleOuter = resolveDropTarget(container, e, activeTarget);
    if (!toggleOuter) {
      debugToggleDrop("drop:skip-no-target", {
        clientX: e.clientX,
        clientY: e.clientY,
        target: getEventTargetSummary(e.target),
      });
      return;
    }

    const toggleBlockId = getBlockIdFromOuter(toggleOuter);
    if (!toggleBlockId) {
      debugToggleDrop("drop:skip-no-block-id", {
        clientX: e.clientX,
        clientY: e.clientY,
      });
      return;
    }
    if (ids.includes(toggleBlockId)) {
      debugToggleDrop("drop:skip-self", {
        toggleBlockId,
        draggedBlockIds: ids,
      });
      return;
    }

    // Prevent ProseMirror from handling this drop
    e.preventDefault();
    e.stopPropagation();

    // Clear ProseMirror's drop cursor (insert indicator) — the stopPropagation
    // above prevents the dropcursor plugin's own drop handler from firing.
    const pmDom = container.querySelector<HTMLElement>(".ProseMirror");
    if (pmDom) {
      pmDom.dispatchEvent(new Event("dragleave", { bubbles: false }));
    }

    const moved = moveBlocksIntoToggle(editor, ids, toggleBlockId);
    debugToggleDrop("drop:handled", {
      toggleBlockId,
      moved,
      draggedBlockIds: ids,
    });

    finalizeToggleDropDragSession(editor);

    // Cleanup
    activeTarget = clearAllCues(container, activeTarget);
    dragActive = false;
    dragSourceResolved = false;
    draggedBlockIds = [];
  };

  // --- dragend: cleanup ---
  const onDragEnd = () => {
    activeTarget = clearAllCues(container, activeTarget);
    dragActive = false;
    dragSourceResolved = false;
    draggedBlockIds = [];
    debugToggleDrop("dragend:clear", {});
  };

  container.addEventListener("dragstart", onDragStart);
  container.addEventListener("dragover", onDragOver);
  container.addEventListener("drop", onDrop, { capture: true });
  container.addEventListener("dragend", onDragEnd);

  return () => {
    container.removeEventListener("dragstart", onDragStart);
    container.removeEventListener("dragover", onDragOver);
    container.removeEventListener("drop", onDrop, { capture: true });
    container.removeEventListener("dragend", onDragEnd);
    clearAllCues(container, activeTarget);
  };
}
