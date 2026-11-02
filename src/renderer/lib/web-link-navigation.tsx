import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { LinkRouter } from "./link-opening";
import type { WebLinkNavigation } from "./web-link-context-menu";

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
