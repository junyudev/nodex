import { createContext, useContext, type ReactNode } from "react";

/** Where a tip can take the person, provided by the workbench that owns those places. */
export interface TipsNavigation {
  readonly openInbox: () => void;
}

const TipsNavigationContext = createContext<TipsNavigation | null>(null);

export function TipsNavigationProvider({
  value,
  children,
}: {
  readonly value: TipsNavigation;
  readonly children: ReactNode;
}) {
  return <TipsNavigationContext.Provider value={value}>{children}</TipsNavigationContext.Provider>;
}

/** Null outside a workbench, where a tip that leads somewhere stays unsaid. */
export function useTipsNavigation(): TipsNavigation | null {
  return useContext(TipsNavigationContext);
}
