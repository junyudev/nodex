import { createContext, useContext, type ReactNode } from "react";

/** Ways other surfaces reach Scheduled, provided by the workbench that owns its route. */
export interface ScheduledNavigation {
  /** Opens a task in Scheduled. */
  readonly openTask: (automationId: string) => void;
  /** Opens a new task that follows a Page as its runbook. */
  readonly scheduleRunbook: (page: {
    readonly pageId: string;
    readonly title: string;
    /** The Project the Page belongs to, where the new task starts. */
    readonly projectId: string | null;
  }) => void;
}

const ScheduledNavigationContext = createContext<ScheduledNavigation | null>(null);

export function ScheduledNavigationProvider({
  value,
  children,
}: {
  readonly value: ScheduledNavigation;
  readonly children: ReactNode;
}) {
  return (
    <ScheduledNavigationContext.Provider value={value}>
      {children}
    </ScheduledNavigationContext.Provider>
  );
}

/** Null outside a workbench, where a surface offers no way into Scheduled. */
export function useScheduledNavigation(): ScheduledNavigation | null {
  return useContext(ScheduledNavigationContext);
}
