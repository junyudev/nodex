import type { FileTree as PierreFileTreeModel } from "@pierre/trees";
import { useEffect, useState, type ReactNode } from "react";
import { withFileTreeElement } from "./file-tree-dom";
import { NodexTooltip } from "./tooltip";

interface FocusedRow {
  readonly element: Element;
  readonly path: string;
}

/** Rows and their labels describe; status lanes, actions, inputs, and loading rows do not. */
function describableRow(target: EventTarget | undefined): FocusedRow | null {
  if (!(target instanceof Element)) return null;
  if (
    target.closest(
      "[data-file-tree-loading], [data-item-section='git'], [data-item-section='decoration'], [data-item-section='action'], input",
    )
  )
    return null;
  const element = target.closest("[data-item-path]");
  const path = element?.getAttribute("data-item-path");
  return element && path ? { element, path } : null;
}

/** Follows the row the keyboard focuses until a pointer, scroll, Escape, or tree change. */
function trackKeyboardFocusedRow(
  model: PierreFileTreeModel,
  tree: HTMLElement,
  onFocusedRow: (row: FocusedRow | null) => void,
) {
  const dismiss = () => onFocusedRow(null);
  const controller = new AbortController();
  const options = { signal: controller.signal };
  tree.addEventListener(
    "focusin",
    (event) => {
      const row = describableRow(event.composedPath()[0]);
      onFocusedRow(row?.element.matches(":focus-visible") ? row : null);
    },
    options,
  );
  tree.addEventListener("pointerdown", dismiss, options);
  tree.addEventListener("scroll", dismiss, { ...options, capture: true });
  tree.addEventListener(
    "keydown",
    (event) => {
      if ((event as KeyboardEvent).key === "Escape") dismiss();
    },
    options,
  );
  const stopMutations = model.onMutation("*", dismiss);
  return () => {
    controller.abort();
    stopMutations();
  };
}

/**
 * Names the keyboard-focused row in full, as a tooltip and its accessible description, so a
 * truncated name or the real path behind a display path stays readable without a pointer.
 */
export function FileTreeFocusDescription({
  model,
  describe,
  children,
}: {
  readonly model: PierreFileTreeModel;
  readonly describe: (path: string) => string | null;
  readonly children: ReactNode;
}) {
  const [focused, setFocused] = useState<FocusedRow | null>(null);
  useEffect(
    () =>
      withFileTreeElement(model, "[data-file-tree-id]", (tree) =>
        trackKeyboardFocusedRow(model, tree, setFocused),
      ),
    [model],
  );
  const description = focused ? describe(focused.path) : null;
  useEffect(() => {
    if (!focused || !description) return;
    focused.element.setAttribute("aria-description", description);
    return () => focused.element.removeAttribute("aria-description");
  }, [description, focused]);
  return (
    <>
      {children}
      {focused && description ? (
        <NodexTooltip
          anchor={focused.element}
          open
          onOpenChange={(open) => {
            if (!open) setFocused(null);
          }}
          side="bottom"
          align="start"
          tooltipClassName="select-text"
          tooltipContent={<div className="text-start wrap-anywhere">{description}</div>}
        />
      ) : null}
    </>
  );
}
