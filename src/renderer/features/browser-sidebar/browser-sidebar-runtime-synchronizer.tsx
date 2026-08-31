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
    const refreshVisibleRuntime = () => {
      if (document.visibilityState === "hidden") return;
      browserSidebarRendererWebviewManager.resyncAttachedHosts();
      void refreshBrowserSidebarRendererStateStore().catch(() => undefined);
    };
    window.addEventListener("focus", refreshVisibleRuntime);
    document.addEventListener("visibilitychange", refreshVisibleRuntime);
    return () => {
      stop();
      window.removeEventListener("focus", refreshVisibleRuntime);
      document.removeEventListener("visibilitychange", refreshVisibleRuntime);
    };
  }, []);
  return <BrowserSidebarBrowserUseWebviewHosts />;
}
