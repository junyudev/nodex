import { createContext, useContext, type ReactNode } from "react";
import type { WebLinkNavigation } from "./web-link-context-menu";

const WebLinkNavigationContext = createContext<WebLinkNavigation | undefined>(undefined);

export function WebLinkNavigationProvider({
  children,
  navigation,
}: {
  readonly children: ReactNode;
  readonly navigation?: WebLinkNavigation;
}) {
  return <WebLinkNavigationContext value={navigation}>{children}</WebLinkNavigationContext>;
}

export function useWebLinkNavigation(): WebLinkNavigation | undefined {
  return useContext(WebLinkNavigationContext);
}
