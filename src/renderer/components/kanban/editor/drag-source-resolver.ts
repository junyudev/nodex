interface BlockLike {
  id: string;
}

interface EditorSelectionLike {
  blocks: BlockLike[];
}

interface EditorProseMirrorSelectionLike {
  nodes?: Array<{ attrs?: { id?: string } }>;
  node?: { attrs?: { id?: string } };
}

interface EditorForDragSourceResolver {
  prosemirrorView?: {
    state: {
      selection: object;
    };
  };
  getSelection?: () => EditorSelectionLike | undefined;
}

export function hasClosest(value: unknown): value is Element {
  return typeof value === "object"
    && value !== null
    && "closest" in value
    && typeof (value as { closest?: unknown }).closest === "function";
}

export function getElementFromTarget(target: EventTarget | null): Element | null {
  if (hasClosest(target)) return target;

  const maybeNode = target as { parentElement?: unknown } | null;
  const parentElement = maybeNode?.parentElement;
  if (!hasClosest(parentElement)) return null;

  return parentElement;
}

/**
 * Resolve the block ID from a DOM element that may be:
 * - The `.bn-block[data-id]` itself
 * - A `.bn-block-outer` wrapping `.bn-block[data-id]` as direct child
 * - An element inside `.bn-block[data-id]` (e.g., `.bn-block-content`)
 */
export function resolveBlockId(el: Element): string | null {
  if (el.matches(".bn-block[data-id]")) {
    return el.getAttribute("data-id");
  }
  const child = el.querySelector<HTMLElement>(":scope > .bn-block[data-id]");
  if (child) return child.getAttribute("data-id");
  return el.closest<HTMLElement>(".bn-block[data-id]")?.getAttribute("data-id") ?? null;
}

/**
 * Resolve dragged block IDs from authoritative signals.
 * Order of preference:
 * 1. ProseMirror selection node IDs (multi/single node selection)
 * 2. BlockNote selection blocks
 * 3. `.ProseMirror-selectednode` DOM fallback
 */
export function resolveDraggedBlockIds(
  editor: EditorForDragSourceResolver,
  container: HTMLElement,
): string[] {
  const selection = editor.prosemirrorView?.state.selection as EditorProseMirrorSelectionLike | undefined;
  if (selection) {
    if (Array.isArray(selection.nodes)) {
      const ids = selection.nodes
        .map((node) => node.attrs?.id)
        .filter((id): id is string => typeof id === "string");
      if (ids.length > 0) return ids;
    }

    if (selection.node?.attrs?.id) {
      return [selection.node.attrs.id];
    }
  }

  try {
    if (typeof editor.getSelection === "function") {
      const blockSelection = editor.getSelection();
      if (blockSelection && blockSelection.blocks.length > 0) {
        const ids = blockSelection.blocks
          .map((block) => block.id)
          .filter((id): id is string => typeof id === "string");
        if (ids.length > 0) return ids;
      }
    }
  } catch {
    // Selection API may throw during active drag updates.
  }

  const selectedNode = container.querySelector<HTMLElement>(".ProseMirror-selectednode");
  if (!selectedNode) return [];

  const id = resolveBlockId(selectedNode);
  return id ? [id] : [];
}
