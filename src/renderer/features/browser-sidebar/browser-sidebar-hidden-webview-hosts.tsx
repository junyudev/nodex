import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  BrowserSidebarBrowserUseCaptureSurfaceEvent,
  BrowserSidebarBrowserUseViewportEvent,
  BrowserSidebarDestroyWebviewRequest,
  BrowserSidebarTabSnapshot,
  BrowserSidebarThemeVariant,
  BrowserSidebarWebviewHostKind,
} from "../../../shared/browser-sidebar";
import {
  makeBrowserSidebarConversationScopeKey,
  makeBrowserSidebarTabKey,
  matchesBrowserSidebarTabIdentity,
  requireWorkbenchBrowserTabProjectionId,
} from "../../../shared/browser-sidebar";
import { isBlankBrowserUrl, normalizeBrowserNavigationUrl } from "../../../shared/browser-url";
import type { WorkbenchTabProjection } from "@/lib/types";
import { notifyBrowserWebviewDestroyed } from "./browser-sidebar-commands";
import { useTheme } from "@/lib/use-theme";
import {
  browserSidebarRendererWebviewManager,
  type BrowserSidebarHostClaimInput,
  type BrowserSidebarHostLease,
} from "./browser-sidebar-webview-manager";
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
  shouldPaint?: boolean;
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

    return browserDescriptors;
  }, [
    browserUseState,
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

/**
 * App-global materializer for Browser Use pages. A Browser session owns its guest independently
 * of any workbench route; panels only borrow presentation ownership for an existing identity.
 */
export function BrowserSidebarBrowserUseWebviewHosts() {
  const { resolved: themeVariant } = useTheme();
  const { browserUseState } = useBrowserSidebarRendererState();
  const [browserUseViewports, setBrowserUseViewports] = useState<
    ReadonlyMap<string, BrowserSidebarBrowserUseViewportEvent>
  >(() => new Map());

  useEffect(() => {
    const unsubscribeBrowserUseViewport = window.api?.on(
      "browser-sidebar-browser-use-viewport",
      (payload) => {
        const event = payload as BrowserSidebarBrowserUseViewportEvent;
        setBrowserUseViewports((current) => {
          const next = new Map(current);
          if (event.viewportSize) next.set(makeBrowserSidebarTabKey(event), event);
          else next.delete(makeBrowserSidebarTabKey(event));
          return next;
        });
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

  useEffect(() => {
    const liveTabKeys = new Set(
      browserUseState.tabs
        .filter((tab) => !tab.released)
        .map((tab) => makeBrowserSidebarTabKey(tab)),
    );
    setBrowserUseViewports((current) => {
      if ([...current.keys()].every((key) => liveTabKeys.has(key))) return current;
      return new Map([...current].filter(([key]) => liveTabKeys.has(key)));
    });
  }, [browserUseState.tabs]);

  const descriptors = useMemo(
    () =>
      browserUseState.tabs.flatMap((tab): HiddenHostDescriptor[] => {
        if (tab.released) return [];
        const viewport = browserUseViewports.get(makeBrowserSidebarTabKey(tab))?.viewportSize;
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
            paintSize: viewport ?? {
              height: tab.viewport.height,
              width: tab.viewport.width,
            },
            shouldPaint:
              browserUseState.activeBrowserTabIdsByConversationScope[
                makeBrowserSidebarConversationScopeKey(tab)
              ] === tab.browserTabId,
          },
        ];
      }),
    [
      browserUseState.activeBrowserTabIdsByConversationScope,
      browserUseState.tabs,
      browserUseViewports,
    ],
  );

  return (
    <>
      {descriptors.map((descriptor) => (
        <HiddenBrowserWebviewHost
          key={`${descriptor.browserConversationId}:${descriptor.browserViewScopeId}:${descriptor.browserTabId}`}
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
  // A retained Browser page owns one webview for the lifetime of its route identity. URL, title,
  // viewport, and presentation changes are live projections of that page, not remount signals.
  const initialUrlRef = useRef(normalizeBrowserNavigationUrl(descriptor.initialUrl));
  const leaseRef = useRef<BrowserSidebarHostLease | null>(null);
  const claimInput = useMemo<BrowserSidebarHostClaimInput>(
    () => ({
      browserConversationId: descriptor.browserConversationId,
      browserViewScopeId: descriptor.browserViewScopeId,
      browserTabId: descriptor.browserTabId,
      browserStorageId: descriptor.browserStorageId,
      projectId: descriptor.projectId,
      hostKind: descriptor.hostKind,
      initialUrl: initialUrlRef.current,
      title: descriptor.title,
      faviconUrl: descriptor.faviconUrl,
      deviceToolbarVisible: descriptor.deviceToolbarVisible,
      deviceToolbarState: descriptor.deviceToolbarState,
      pagePersistence: descriptor.hostKind === "retained" ? "browser-use" : "durable",
      // No visible panel route exists to establish hidden and retained tabs.
      tabRegistration: "ensure",
      presentation: {
        bounds:
          descriptor.hostKind === "retained"
            ? {
                height: descriptor.paintSize?.height ?? 720,
                width: descriptor.paintSize?.width ?? 1_280,
                x: -10_000,
                y: 0,
              }
            : null,
        isVisible: false,
        // Bootstrap and paint are separate leases. Only the actively controlled Browser Use page
        // paints while hidden; capture can temporarily supply a paint surface for any retained tab.
        shouldPaint: descriptor.shouldPaint === true,
      },
      themeVariant,
    }),
    [descriptor, themeVariant],
  );
  const claimInputRef = useRef(claimInput);
  claimInputRef.current = claimInput;

  useLayoutEffect(() => {
    if (!window.api) return undefined;
    if (isBlankBrowserUrl(initialUrlRef.current) && descriptor.hostKind !== "retained") {
      return undefined;
    }
    const lease = browserSidebarRendererWebviewManager.claimHost(claimInputRef.current);
    leaseRef.current = lease;
    return () => {
      if (leaseRef.current === lease) leaseRef.current = null;
      lease.release();
    };
  }, [
    descriptor.browserConversationId,
    descriptor.browserStorageId,
    descriptor.browserTabId,
    descriptor.browserViewScopeId,
    descriptor.hostKind,
    descriptor.projectId,
  ]);

  useLayoutEffect(() => {
    leaseRef.current?.update(claimInput);
  }, [claimInput]);

  return null;
}
