import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

const WorkbenchTitlebarContext = createContext<HTMLElement | null>(null);

export function WorkbenchTitlebarProvider({
  host,
  active = true,
  children,
}: {
  readonly host: HTMLElement | null;
  readonly active?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <WorkbenchTitlebarContext.Provider value={active ? host : null}>
      {children}
    </WorkbenchTitlebarContext.Provider>
  );
}

const PANE_CHROME_SCOPE_ATTRIBUTES = [
  "data-app-shell-focus-area",
  "data-panel-group-leaf-id",
  "data-app-shell-panel-id",
] as const;

/** Keep native shortcut routing attached to the same pane after its chrome is portalled. */
function projectPaneScope(anchor: HTMLElement, chrome: HTMLElement) {
  for (const attribute of PANE_CHROME_SCOPE_ATTRIBUTES) {
    const value = anchor.closest(`[${attribute}]`)?.getAttribute(attribute);
    if (value === null || value === undefined) {
      chrome.removeAttribute(attribute);
      continue;
    }
    chrome.setAttribute(attribute, value);
  }
}

/** Top-edge pane chrome occupies the window titlebar without reserving content height. */
export function WorkbenchPaneTitlebar({
  enabled,
  children,
}: {
  readonly enabled: boolean;
  readonly children: ReactNode;
}) {
  const host = useContext(WorkbenchTitlebarContext);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const chromeRef = useRef<HTMLDivElement | null>(null);
  const portalHost = enabled ? host : null;

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const chrome = chromeRef.current;
    const view = portalHost?.ownerDocument.defaultView;
    if (!portalHost || !anchor || !chrome || !view) return;

    const syncGeometry = () => {
      const hostBounds = portalHost.getBoundingClientRect();
      const anchorBounds = anchor.getBoundingClientRect();
      const scale = portalHost.clientWidth > 0 ? hostBounds.width / portalHost.clientWidth : 1;
      const zoom = Number.isFinite(scale) && scale > 0 ? scale : 1;
      let visibleLeft = anchorBounds.left;
      let visibleRight = anchorBounds.right;
      let opacity = 1;
      for (
        let element = anchor.parentElement;
        element && !element.contains(portalHost);
        element = element.parentElement
      ) {
        const style = view.getComputedStyle(element);
        const ancestorOpacity = Number.parseFloat(style.opacity);
        if (Number.isFinite(ancestorOpacity)) opacity *= ancestorOpacity;
        if (!["hidden", "clip", "auto", "scroll"].includes(style.overflowX)) continue;
        const bounds = element.getBoundingClientRect();
        const elementScale = element.offsetWidth > 0 ? bounds.width / element.offsetWidth : zoom;
        const clipLeft = bounds.left + element.clientLeft * elementScale;
        visibleLeft = Math.max(visibleLeft, clipLeft);
        visibleRight = Math.min(visibleRight, clipLeft + element.clientWidth * elementScale);
      }
      chrome.style.left = `${(anchorBounds.left - hostBounds.left) / zoom}px`;
      chrome.style.width = `${anchorBounds.width / zoom}px`;
      chrome.style.clipPath = `inset(0px ${Math.max(0, anchorBounds.right - visibleRight) / zoom}px 0px ${Math.max(0, visibleLeft - anchorBounds.left) / zoom}px)`;
      chrome.style.opacity = String(opacity);
      chrome.style.visibility = visibleRight > visibleLeft && opacity > 0 ? "visible" : "hidden";
      projectPaneScope(anchor, chrome);
    };
    syncGeometry();

    const observed = new Set<Element>([portalHost]);
    for (let element: HTMLElement | null = anchor; element; element = element.parentElement) {
      observed.add(element);
    }
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncGeometry);
    const mutationObserver =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(syncGeometry);
    for (const element of observed) {
      resizeObserver?.observe(element);
      mutationObserver?.observe(element, {
        attributes: true,
        attributeFilter: ["style", "class", ...PANE_CHROME_SCOPE_ATTRIBUTES],
      });
    }
    view.addEventListener("resize", syncGeometry);
    view.addEventListener("scroll", syncGeometry, true);
    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      view.removeEventListener("resize", syncGeometry);
      view.removeEventListener("scroll", syncGeometry, true);
    };
  }, [portalHost]);

  if (!portalHost) return children;

  return (
    <>
      <div
        ref={anchorRef}
        aria-hidden="true"
        data-workbench-pane-titlebar-anchor
        className="h-0 w-full min-w-0 shrink-0"
      />
      {createPortal(
        <div
          ref={chromeRef}
          data-workbench-pane-titlebar
          className="pointer-events-none absolute top-0 h-full min-w-0 bg-transparent [&_a]:pointer-events-auto [&_button]:pointer-events-auto [&_input]:pointer-events-auto [&_select]:pointer-events-auto [&_textarea]:pointer-events-auto [&_[data-panel-tab-row]]:pointer-events-auto"
          style={{ visibility: "hidden" }}
        >
          {children}
        </div>,
        portalHost,
      )}
    </>
  );
}
