import { FILE_TREE_TAG_NAME } from "@pierre/trees";
import { useId, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LoadingResultsShimmer } from "./loading-results-shimmer";

const LOADING_LABEL = "Loading directory entries…";
const LOADING_ATTRIBUTE = "data-file-tree-loading";
const BLOCKED_EVENTS = ["click", "dblclick", "contextmenu", "keydown"] as const;

interface LoadingMark {
  readonly path: string;
  readonly label: string | null;
  readonly slot: HTMLSlotElement;
}

/** Placeholder rows are not items: they cannot be opened, selected, or given a menu. */
function blockLoadingRowEvent(event: Event) {
  if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
  const onLoadingRow = event
    .composedPath()
    .some((target) => target instanceof Element && target.hasAttribute(LOADING_ATTRIBUTE));
  if (!onLoadingRow) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function unmark(row: Element, mark: LoadingMark) {
  mark.slot.remove();
  row.removeAttribute(LOADING_ATTRIBUTE);
  row.removeAttribute("aria-disabled");
  if (row.getAttribute("aria-label") !== LOADING_LABEL) return;
  if (row.getAttribute("data-item-path") === mark.path && mark.label !== null)
    row.setAttribute("aria-label", mark.label);
  else row.removeAttribute("aria-label");
}

/** Marks every mounted placeholder row and slots its skeleton into the row's content. */
function trackLoadingRows(root: ShadowRoot, rows: ReadonlySet<string>, slotPrefix: string) {
  const order = [...rows];
  const marked = new Map<Element, LoadingMark>();
  const sync = () => {
    for (const [row, mark] of marked) {
      const path = row.getAttribute("data-item-path");
      if (path === mark.path && rows.has(path) && root.contains(mark.slot)) continue;
      unmark(row, mark);
      marked.delete(row);
    }
    for (const row of root.querySelectorAll("[data-item-path]")) {
      const path = row.getAttribute("data-item-path");
      if (!path || !rows.has(path)) continue;
      const content = row.querySelector("[data-item-section='content']");
      if (!content) continue;
      if (!marked.has(row)) {
        const slot = document.createElement("slot");
        slot.name = `${slotPrefix}-${order.indexOf(path)}`;
        marked.set(row, { path, label: row.getAttribute("aria-label"), slot });
        content.append(slot);
      }
      row.setAttribute(LOADING_ATTRIBUTE, "");
      row.setAttribute("aria-disabled", "true");
      row.setAttribute("aria-label", LOADING_LABEL);
    }
  };
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-item-path"],
  });
  for (const type of BLOCKED_EVENTS) root.addEventListener(type, blockLoadingRowEvent, true);
  return () => {
    observer.disconnect();
    for (const type of BLOCKED_EVENTS) root.removeEventListener(type, blockLoadingRowEvent, true);
    for (const [row, mark] of marked) unmark(row, mark);
  };
}

/**
 * Renders a skeleton in each placeholder row of the tree it wraps, while that folder's entries
 * load, and announces the loading once.
 */
export function FileTreeLoadingRows({
  rows,
  children,
}: {
  readonly rows: ReadonlySet<string>;
  readonly children: ReactNode;
}) {
  const slotPrefix = useId();
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const root = host?.shadowRoot;
    if (!root || rows.size === 0) return;
    return trackLoadingRows(root, rows, slotPrefix);
  }, [host, rows, slotPrefix]);
  return (
    <div
      ref={(element) => setHost(element?.querySelector<HTMLElement>(FILE_TREE_TAG_NAME) ?? null)}
      className="contents"
    >
      {children}
      {rows.size > 0 ? (
        <span className="sr-only" role="status">
          {LOADING_LABEL}
        </span>
      ) : null}
      {host && rows.size > 0
        ? createPortal(
            [...rows].map((path, index) => (
              <div key={path} slot={`${slotPrefix}-${index}`} aria-hidden="true">
                <LoadingResultsShimmer className="w-24" lines={1} minWidth={100} size="sm" />
              </div>
            )),
            host,
          )
        : null}
    </div>
  );
}
