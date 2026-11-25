import type { BrowserSidebarImageDragStateEvent } from "../../../shared/browser-sidebar";
import { clearBrowserImageDragState } from "./browser-image-drag-state";
import { useEffect } from "react";
import { BrowserSidebarBrowserUseWebviewHosts } from "./browser-sidebar-hidden-webview-hosts";
import {
  refreshBrowserSidebarRendererStateStore,
  startBrowserSidebarRendererStateStore,
} from "./browser-sidebar-renderer-state-store";
import { browserSidebarRendererWebviewManager } from "./browser-sidebar-webview-manager";

export function BrowserSidebarRuntimeSynchronizer() {
  useEffect(() => {
    const stop = startBrowserSidebarRendererStateStore();
    const stopImageDrag = window.api?.on("browser-sidebar-image-drag-state", (payload) => {
      const event = payload as BrowserSidebarImageDragStateEvent;
      if (!event.isActive) clearBrowserImageDragState(event.dragToken);
    });
    const refreshVisibleRuntime = () => {
      if (document.visibilityState === "hidden") return;
      browserSidebarRendererWebviewManager.resyncAttachedHosts();
      void refreshBrowserSidebarRendererStateStore().catch(() => undefined);
    };
    window.addEventListener("focus", refreshVisibleRuntime);
    document.addEventListener("visibilitychange", refreshVisibleRuntime);
    return () => {
      stop();
      stopImageDrag?.();
      window.removeEventListener("focus", refreshVisibleRuntime);
      document.removeEventListener("visibilitychange", refreshVisibleRuntime);
    };
  }, []);
  return <BrowserSidebarBrowserUseWebviewHosts />;
}
