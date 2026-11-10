import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { BrowserSidebarTabIdentity } from "../../../shared/browser-sidebar";
import { browserSidebarRendererWebviewManager } from "./browser-sidebar-webview-manager";

export function useBrowserPageOverlayHost(identity: BrowserSidebarTabIdentity): HTMLElement | null {
  return useSyncExternalStore(
    browserSidebarRendererWebviewManager.subscribePageOverlayHosts,
    () => browserSidebarRendererWebviewManager.getPageOverlayHost(identity),
    () => null,
  );
}

/**
 * Draws Browser UI over a page. The overlay covers exactly the presented page, follows it when it
 * moves or hides, and lets the pointer through to the page except where a child opts back in with
 * `pointer-events-auto`.
 */
export function BrowserPageOverlay({
  identity,
  children,
}: {
  identity: BrowserSidebarTabIdentity;
  children: ReactNode;
}) {
  const host = useBrowserPageOverlayHost(identity);
  if (!host) return null;
  return createPortal(
    // The page container sits outside the zoomed app shell and is sized in window pixels.
    <div className="absolute inset-0" style={{ zoom: "var(--codex-window-zoom, 1)" }}>
      {children}
    </div>,
    host,
  );
}
