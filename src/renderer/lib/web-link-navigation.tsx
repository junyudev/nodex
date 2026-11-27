import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { LinkOpenRequest } from "../../shared/link-opening";
import { snapshotLinkActivation } from "./link-activation";
import { openLink, type LinkRouter } from "./link-opening";
import { openWebLinkContextMenu, type WebLinkNavigation } from "./web-link-context-menu";

const WebLinkNavigationContext = createContext<WebLinkNavigation | undefined>(undefined);

export function WebLinkNavigationProvider({
  children,
  navigation,
}: {
  readonly children: ReactNode;
  readonly navigation?: WebLinkNavigation;
}) {
  const parent = useContext(WebLinkNavigationContext);
  const value = useMemo(
    () =>
      navigation
        ? {
            ...parent,
            ...navigation,
            openTab: navigation.openTab ?? parent?.openTab,
            openWindow: navigation.openWindow ?? parent?.openWindow,
          }
        : parent,
    [navigation, parent],
  );
  return <WebLinkNavigationContext value={value}>{children}</WebLinkNavigationContext>;
}

export function useWebLinkNavigation(): WebLinkNavigation | undefined {
  return useContext(WebLinkNavigationContext);
}

/** All link entry points share the owning Workbench's destination and presentation capability. */
export function LinkOpeningProvider({
  children,
  router,
}: {
  readonly children: ReactNode;
  readonly router: LinkRouter;
}) {
  const navigation = useMemo<WebLinkNavigation>(
    () => ({
      ...router,
      openTab: router.browserAvailable
        ? (url) =>
            router.openLink({
              url,
              initiator: "link_context_menu",
              openTarget: "in-app-browser",
              disposition: "new-tab",
            })
        : undefined,
      openWindow: router.browserAvailable
        ? (url) =>
            router.openLink({
              url,
              initiator: "link_context_menu",
              openTarget: "in-app-browser",
              presentationIntent: "new-window",
            })
        : undefined,
    }),
    [router],
  );
  return <WebLinkNavigationProvider navigation={navigation}>{children}</WebLinkNavigationProvider>;
}
export function useLinkOpening(): LinkRouter | undefined {
  const navigation = useWebLinkNavigation();
  return navigation?.openLink
    ? { browserAvailable: navigation.browserAvailable ?? false, openLink: navigation.openLink }
    : undefined;
}

/** Binds a link control to the current Workbench while preserving pointer and menu intent. */
export function useRoutedWebLink() {
  const navigation = useWebLinkNavigation();
  return (request: Omit<LinkOpenRequest, "activation">) => {
    const activate = (event: ReactMouseEvent<HTMLElement>) => {
      if (event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return;
      event.preventDefault();
      event.stopPropagation();
      void (navigation?.openLink ?? openLink)({
        ...request,
        activation: snapshotLinkActivation(event),
      });
    };
    const showMenu = (element: HTMLElement, x: number, y: number) => {
      void openWebLinkContextMenu({
        url: request.url,
        navigation,
        x,
        y,
        selectedText: element.ownerDocument.getSelection()?.toString(),
        isCurrent: () => element.isConnected && !element.closest("[inert]"),
      }).catch(() => undefined);
    };
    return {
      onClick: activate,
      onAuxClick: activate,
      onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
        if (!/^https?:\/\//iu.test(request.url)) return;
        event.preventDefault();
        event.stopPropagation();
        showMenu(event.currentTarget, event.clientX, event.clientY);
      },
      onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
        if (!/^https?:\/\//iu.test(request.url)) return;
        if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
        event.preventDefault();
        event.stopPropagation();
        const bounds = event.currentTarget.getBoundingClientRect();
        showMenu(event.currentTarget, bounds.left, bounds.bottom);
      },
    };
  };
}
