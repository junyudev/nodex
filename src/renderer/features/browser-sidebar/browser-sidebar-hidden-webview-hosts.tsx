import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  BrowserSidebarBrowserUseCaptureSurfaceEvent,
  BrowserSidebarBrowserUseViewportEvent,
  BrowserSidebarDestroyWebviewRequest,
  BrowserSidebarTabSnapshot,
  BrowserSidebarThemeVariant,
  BrowserSidebarWebviewHostCreated,
  BrowserSidebarWebviewHostKind,
} from "../../../shared/browser-sidebar";
import {
  matchesBrowserSidebarTabIdentity,
  requireWorkbenchBrowserTabProjectionId,
} from "../../../shared/browser-sidebar";
import { isBlankBrowserUrl, normalizeBrowserNavigationUrl } from "../../../shared/browser-url";
import type { WorkbenchTabProjection } from "@/lib/types";
import {
  invokeBrowserSidebarCommand,
  notifyBrowserWebviewDestroyed,
  notifyBrowserWebviewHostCreated,
} from "./browser-sidebar-commands";
import { useTheme } from "@/lib/use-theme";
import { browserSidebarRendererWebviewManager } from "./browser-sidebar-webview-manager";
import { useBrowserSidebarRendererState } from "./browser-sidebar-renderer-state-store";
import {
  readBrowserConfigDeviceToolbarState,
  readBrowserConfigDeviceToolbarVisible,
  readBrowserConfigFavicon,
  readBrowserConfigStorageId,
  readBrowserConfigTitle,
  readBrowserConfigUrl,
} from "./browser-sidebar-tab-config";

interface BrowserSidebarHiddenWebviewHostsProps {
  durableBrowserConversationId: string;
  browserViewScopeId: string;
  tabs: WorkbenchTabProjection[];
  mountedTabIds: ReadonlySet<string>;
  visibleTabIds: ReadonlySet<string>;
}

interface HiddenHostDescriptor {
  browserConversationId: string;
  browserViewScopeId: string;
  browserTabId: string;
  browserStorageId: string;
  projectId: string | null;
  hostKind: BrowserSidebarWebviewHostKind;
  initialUrl: string;
  title?: string;
  faviconUrl?: string;
  deviceToolbarVisible?: boolean;
  deviceToolbarState?: BrowserSidebarTabSnapshot["deviceToolbarState"];
  paintSize?: { height: number; width: number };
}

export function BrowserSidebarHiddenWebviewHosts({
  durableBrowserConversationId,
  browserViewScopeId,
  tabs,
  mountedTabIds,
  visibleTabIds,
}: BrowserSidebarHiddenWebviewHostsProps) {
  const { resolved: themeVariant } = useTheme();
  const {
    state: { tabs: snapshots },
    browserUseState,
  } = useBrowserSidebarRendererState();
  const [browserUseViewport, setBrowserUseViewport] =
    useState<BrowserSidebarBrowserUseViewportEvent | null>(null);

  useEffect(() => {
    const unsubscribeBrowserUseViewport = window.api?.on(
      "browser-sidebar-browser-use-viewport",
      (payload) => {
        setBrowserUseViewport(payload as BrowserSidebarBrowserUseViewportEvent);
      },
    );
    const unsubscribeBrowserUseCaptureSurface = window.api?.on(
      "browser-sidebar-browser-use-capture-surface",
      (payload) => {
        browserSidebarRendererWebviewManager.setBrowserUseCaptureSurface(
          payload as BrowserSidebarBrowserUseCaptureSurfaceEvent,
        );
      },
    );
    const unsubscribeDestroyWebview = window.api?.on(
      "browser-sidebar-destroy-webview",
      (payload) => {
        const request = payload as BrowserSidebarDestroyWebviewRequest | undefined;
        if (!request) return;
        browserSidebarRendererWebviewManager.destroyWebviewAtHostRequest(request, (event) => {
          void notifyBrowserWebviewDestroyed(event);
        });
      },
    );
    return () => {
      unsubscribeBrowserUseViewport?.();
      unsubscribeBrowserUseCaptureSurface?.();
      unsubscribeDestroyWebview?.();
    };
  }, []);

  const descriptors = useMemo(() => {
    const liveBrowserUseTabs = browserUseState.tabs.filter(
      (tab) => tab.browserViewScopeId === browserViewScopeId && !tab.released,
    );
    const browserDescriptors = tabs.flatMap((tab): HiddenHostDescriptor[] => {
      if (tab.kind !== "browser") return [];
      if (visibleTabIds.has(tab.id) || mountedTabIds.has(tab.id)) return [];
      const browserTabId = requireWorkbenchBrowserTabProjectionId(tab);
      const identity = {
        browserConversationId: durableBrowserConversationId,
        browserViewScopeId,
        browserTabId,
      };
      if (
        liveBrowserUseTabs.some((runtimeTab) =>
          matchesBrowserSidebarTabIdentity(runtimeTab, identity),
        )
      )
        return [];
      const snapshot = snapshots.find((candidate) =>
        matchesBrowserSidebarTabIdentity(candidate, identity),
      );
      const snapshotUrl = snapshot?.url && !isBlankBrowserUrl(snapshot.url) ? snapshot.url : null;
      const configUrl = readBrowserConfigUrl(tab);
      const initialUrl = snapshotUrl ?? configUrl;
      if (isBlankBrowserUrl(initialUrl)) return [];
      if (snapshot && !snapshot.hasBrowserPage) return [];
      return [
        {
          browserConversationId: durableBrowserConversationId,
          browserViewScopeId,
          browserTabId,
          browserStorageId:
            snapshot?.browserStorageId ??
            readBrowserConfigStorageId(tab) ??
            `browser:legacy:${browserTabId}`,
          projectId: tab.projectId,
          hostKind: "background",
          initialUrl,
          title: snapshot?.title ?? readBrowserConfigTitle(tab) ?? tab.title,
          faviconUrl: snapshot?.faviconUrl ?? readBrowserConfigFavicon(tab),
          deviceToolbarVisible:
            snapshot?.deviceToolbarVisible ?? readBrowserConfigDeviceToolbarVisible(tab),
          deviceToolbarState:
            snapshot?.deviceToolbarState ?? readBrowserConfigDeviceToolbarState(tab),
        },
      ];
    });

    const browserUseDescriptors = liveBrowserUseTabs.flatMap((tab): HiddenHostDescriptor[] => {
      const hasMountedWorkbenchTab =
        tab.browserConversationId === durableBrowserConversationId &&
        tabs.some(
          (workbenchTab) =>
            workbenchTab.kind === "browser" &&
            (visibleTabIds.has(workbenchTab.id) || mountedTabIds.has(workbenchTab.id)) &&
            requireWorkbenchBrowserTabProjectionId(workbenchTab) === tab.browserTabId,
        );
      if (hasMountedWorkbenchTab) return [];
      return [
        {
          browserConversationId: tab.browserConversationId,
          browserViewScopeId: tab.browserViewScopeId,
          browserTabId: tab.browserTabId,
          browserStorageId: `browser:use:${tab.browserTabId}`,
          projectId: tab.projectId,
          hostKind: "retained",
          initialUrl: tab.url,
          title: tab.title,
          paintSize: (matchesBrowserSidebarTabIdentity(browserUseViewport, tab)
            ? browserUseViewport?.viewportSize
            : null) ?? {
            height: tab.viewport.height,
            width: tab.viewport.width,
          },
        },
      ];
    });

    return [...browserDescriptors, ...browserUseDescriptors];
  }, [
    browserUseState,
    browserUseViewport,
    browserViewScopeId,
    durableBrowserConversationId,
    mountedTabIds,
    snapshots,
    tabs,
    visibleTabIds,
  ]);

  return (
    <>
      {descriptors.map((descriptor) => (
        <HiddenBrowserWebviewHost
          key={`${descriptor.hostKind}:${descriptor.browserConversationId}:${descriptor.browserViewScopeId}:${descriptor.browserTabId}`}
          descriptor={descriptor}
          themeVariant={themeVariant}
        />
      ))}
    </>
  );
}

function HiddenBrowserWebviewHost({
  descriptor,
  themeVariant,
}: {
  descriptor: HiddenHostDescriptor;
  themeVariant: BrowserSidebarThemeVariant;
}) {
  const initialUrl = normalizeBrowserNavigationUrl(descriptor.initialUrl);
  const [registered, setRegistered] = useState(false);
  const syncHostPresentationRef = useRef<(() => void) | null>(null);
  const themeVariantRef = useRef(themeVariant);
  themeVariantRef.current = themeVariant;

  useEffect(() => {
    if (!window.api) return;
    let cancelled = false;
    void (async () => {
      const rendererResult = await invokeBrowserSidebarCommand({
        type: "register-renderer-session",
        browserViewScopeId: descriptor.browserViewScopeId,
        rendererInstanceId: browserSidebarRendererWebviewManager.getRendererInstanceId(),
      });
      if (!rendererResult.ok || cancelled) return;
      const result = await invokeBrowserSidebarCommand({
        type: "register-tab",
        browserConversationId: descriptor.browserConversationId,
        browserViewScopeId: descriptor.browserViewScopeId,
        browserTabId: descriptor.browserTabId,
        browserStorageId: descriptor.browserStorageId,
        projectId: descriptor.projectId,
        initialUrl,
        title: descriptor.title,
        faviconUrl: descriptor.faviconUrl,
        deviceToolbarVisible: descriptor.deviceToolbarVisible,
        deviceToolbarState: descriptor.deviceToolbarState,
      });
      if (result.ok && !cancelled) setRegistered(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    descriptor.browserConversationId,
    descriptor.browserStorageId,
    descriptor.browserTabId,
    descriptor.browserViewScopeId,
    descriptor.deviceToolbarState,
    descriptor.deviceToolbarVisible,
    descriptor.faviconUrl,
    descriptor.projectId,
    descriptor.title,
    initialUrl,
  ]);

  useLayoutEffect(() => {
    if (!window.api || !registered) return undefined;
    if (isBlankBrowserUrl(initialUrl) && descriptor.hostKind !== "retained") return undefined;
    const mountGeneration = browserSidebarRendererWebviewManager.claimMountGeneration({
      browserConversationId: descriptor.browserConversationId,
      browserViewScopeId: descriptor.browserViewScopeId,
      browserTabId: descriptor.browserTabId,
    });
    const hostGeneration = browserSidebarRendererWebviewManager.claimHostGeneration({
      browserConversationId: descriptor.browserConversationId,
      browserViewScopeId: descriptor.browserViewScopeId,
      browserTabId: descriptor.browserTabId,
    });
    const rendererInstanceId = browserSidebarRendererWebviewManager.getRendererInstanceId();
    let disposed = false;
    let started = false;
    const syncHostPresentation = () => {
      if (!started || disposed) return;
      browserSidebarRendererWebviewManager.syncWebview({
        browserConversationId: descriptor.browserConversationId,
        browserViewScopeId: descriptor.browserViewScopeId,
        browserTabId: descriptor.browserTabId,
        browserStorageId: descriptor.browserStorageId,
        projectId: descriptor.projectId,
        hostKind: descriptor.hostKind,
        initialUrl,
        bounds:
          descriptor.hostKind === "retained"
            ? {
                height: descriptor.paintSize?.height ?? 720,
                width: descriptor.paintSize?.width ?? 1_280,
                x: -10_000,
                y: 0,
              }
            : null,
        mountGeneration,
        isVisible: false,
        shouldPaint: descriptor.hostKind === "retained",
        onHostCreated: (event: BrowserSidebarWebviewHostCreated) => {
          void notifyBrowserWebviewHostCreated(event);
        },
      });
      void invokeBrowserSidebarCommand({
        type: "sync-host",
        browserConversationId: descriptor.browserConversationId,
        browserViewScopeId: descriptor.browserViewScopeId,
        browserTabId: descriptor.browserTabId,
        rendererInstanceId,
        hostGeneration,
        mountGeneration,
        hostKind: descriptor.hostKind,
        presented: false,
        themeVariant: themeVariantRef.current,
        visible: false,
      });
    };
    syncHostPresentationRef.current = syncHostPresentation;
    void invokeBrowserSidebarCommand({
      type: "register-host",
      browserConversationId: descriptor.browserConversationId,
      browserViewScopeId: descriptor.browserViewScopeId,
      browserTabId: descriptor.browserTabId,
      browserStorageId: descriptor.browserStorageId,
      rendererInstanceId,
      hostGeneration,
      mountGeneration,
      hostKind: descriptor.hostKind,
      pagePersistence: descriptor.hostKind === "retained" ? "browser-use" : "durable",
      themeVariant: themeVariantRef.current,
    }).then((result) => {
      if (!result.ok || disposed) return;
      started = true;
      syncHostPresentation();
    });

    return () => {
      disposed = true;
      if (syncHostPresentationRef.current === syncHostPresentation) {
        syncHostPresentationRef.current = null;
      }
      if (!started) return;
      void invokeBrowserSidebarCommand({
        type: "sync-host",
        browserConversationId: descriptor.browserConversationId,
        browserViewScopeId: descriptor.browserViewScopeId,
        browserTabId: descriptor.browserTabId,
        rendererInstanceId,
        hostGeneration,
        mountGeneration,
        hostKind: descriptor.hostKind,
        presented: false,
        themeVariant: themeVariantRef.current,
        visible: false,
      });
      browserSidebarRendererWebviewManager.detachWebview(
        {
          browserConversationId: descriptor.browserConversationId,
          browserViewScopeId: descriptor.browserViewScopeId,
          browserTabId: descriptor.browserTabId,
        },
        mountGeneration,
      );
    };
  }, [
    descriptor.browserConversationId,
    descriptor.browserStorageId,
    descriptor.browserTabId,
    descriptor.browserViewScopeId,
    descriptor.hostKind,
    descriptor.paintSize?.height,
    descriptor.paintSize?.width,
    descriptor.projectId,
    initialUrl,
    registered,
  ]);

  useLayoutEffect(() => {
    syncHostPresentationRef.current?.();
  }, [themeVariant]);

  return null;
}
