import { NESTED_EDITOR_EVENT_BOUNDARY_ATTRIBUTE } from "@blocknote/core";

export const EDITOR_SELECTION_SURFACE_ATTRIBUTE = "data-nodex-editor-selection-surface";
export const ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE =
  "data-nodex-active-editor-selection-surface";
export const EMBEDDED_EDITOR_SELECTION_CONTEXT_ATTRIBUTE =
  "data-nodex-embedded-editor-selection-context";

export const embeddedEditorSelectionContextAttributes = {
  [EMBEDDED_EDITOR_SELECTION_CONTEXT_ATTRIBUTE]: "",
  [NESTED_EDITOR_EVENT_BOUNDARY_ATTRIBUTE]: "",
} as const;

const ACTIVE_EDITOR_SELECTION_SURFACE_SELECTOR = `[${ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE}]`;
const EDITOR_SELECTION_SURFACE_SELECTOR = `[${EDITOR_SELECTION_SURFACE_ATTRIBUTE}]`;
const EMBEDDED_EDITOR_SELECTION_CONTEXT_SELECTOR = `[${EMBEDDED_EDITOR_SELECTION_CONTEXT_ATTRIBUTE}]`;

interface EditorSelectionRootCoordinator {
  readonly surfaces: Set<HTMLElement>;
  readonly handleInteraction: (event: Event) => void;
}

const rootCoordinators = new WeakMap<Node, EditorSelectionRootCoordinator>();

function surfaceRoot(surface: HTMLElement): Node {
  return surface.getRootNode();
}

function activeSurfaces(root: Node): HTMLElement[] {
  if (!("querySelectorAll" in root)) return [];
  const descendants = Array.from(
    (root as ParentNode).querySelectorAll<HTMLElement>(ACTIVE_EDITOR_SELECTION_SURFACE_SELECTOR),
  );
  if (!(root instanceof HTMLElement)) return descendants;
  if (!root.hasAttribute(ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE)) return descendants;
  return [root, ...descendants];
}

/** Makes one editor the sole owner of Block-selection presentation in its DOM root. */
export function claimEditorSelectionSurface(surface: HTMLElement): void {
  const root = surfaceRoot(surface);
  for (const activeSurface of activeSurfaces(root)) {
    if (activeSurface === surface) continue;
    activeSurface.removeAttribute(ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE);
  }
  surface.setAttribute(ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE, "");
}

/** Clears ownership when interaction enters a non-editor part of an embedded surface. */
export function clearActiveEditorSelectionSurface(reference: HTMLElement): void {
  for (const activeSurface of activeSurfaces(surfaceRoot(reference))) {
    activeSurface.removeAttribute(ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE);
  }
}

/** Releases a mounted editor without disturbing a newer active surface. */
export function releaseEditorSelectionSurface(surface: HTMLElement): void {
  surface.removeAttribute(ACTIVE_EDITOR_SELECTION_SURFACE_ATTRIBUTE);
}

function registeredSurfaceFromTarget(
  target: Element,
  surfaces: ReadonlySet<HTMLElement>,
): HTMLElement | null {
  let candidate = target.closest<HTMLElement>(EDITOR_SELECTION_SURFACE_SELECTOR);
  while (candidate) {
    if (surfaces.has(candidate)) return candidate;
    candidate =
      candidate.parentElement?.closest<HTMLElement>(EDITOR_SELECTION_SURFACE_SELECTOR) ?? null;
  }
  return null;
}

function createRootCoordinator(root: Node): EditorSelectionRootCoordinator {
  const surfaces = new Set<HTMLElement>();
  const handleInteraction = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const surface = registeredSurfaceFromTarget(target, surfaces);
    if (!surface) {
      const reference = surfaces.values().next().value;
      if (reference) clearActiveEditorSelectionSurface(reference);
      return;
    }

    const embeddedContext = target.closest<HTMLElement>(EMBEDDED_EDITOR_SELECTION_CONTEXT_SELECTOR);
    if (embeddedContext && surface.contains(embeddedContext)) {
      clearActiveEditorSelectionSurface(surface);
      return;
    }

    claimEditorSelectionSurface(surface);
  };

  root.addEventListener("focusin", handleInteraction, true);
  root.addEventListener("pointerdown", handleInteraction, true);
  return { surfaces, handleInteraction };
}

function activeElementInRoot(root: Node): Element | null {
  if (!("activeElement" in root)) return null;
  return (root as Document | ShadowRoot).activeElement;
}

/**
 * Registers one mounted editor with the DOM-root selection coordinator.
 * The coordinator follows interaction across nested editors and clears purely
 * visual selection ownership when pointer or focus moves outside every editor.
 */
export function registerEditorSelectionSurface(surface: HTMLElement): () => void {
  const root = surfaceRoot(surface);
  const coordinator = rootCoordinators.get(root) ?? createRootCoordinator(root);
  rootCoordinators.set(root, coordinator);
  coordinator.surfaces.add(surface);
  surface.setAttribute(EDITOR_SELECTION_SURFACE_ATTRIBUTE, "");

  const activeElement = activeElementInRoot(root);
  if (activeElement) {
    const activeSurface = registeredSurfaceFromTarget(activeElement, coordinator.surfaces);
    if (activeSurface) claimEditorSelectionSurface(activeSurface);
  }

  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    coordinator.surfaces.delete(surface);
    releaseEditorSelectionSurface(surface);
    surface.removeAttribute(EDITOR_SELECTION_SURFACE_ATTRIBUTE);
    if (coordinator.surfaces.size > 0) return;

    root.removeEventListener("focusin", coordinator.handleInteraction, true);
    root.removeEventListener("pointerdown", coordinator.handleInteraction, true);
    rootCoordinators.delete(root);
  };
}
