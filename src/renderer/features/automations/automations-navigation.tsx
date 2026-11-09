import { createContext, useContext, type ReactNode } from "react";

/** Ways other surfaces reach Automations, provided by the workbench that owns its route. */
export interface AutomationsNavigation {
  /** Opens a task in Automations. */
  readonly openTask: (automationId: string) => void;
  /** Opens a new task that follows a Page as its runbook. */
  readonly scheduleRunbook: (page: {
    readonly pageId: string;
    readonly title: string;
    /** The Project the Page belongs to, where the new task starts. */
    readonly projectId: string | null;
  }) => void;
}

const AutomationsNavigationContext = createContext<AutomationsNavigation | null>(null);

export function AutomationsNavigationProvider({
  value,
  children,
}: {
  readonly value: AutomationsNavigation;
  readonly children: ReactNode;
}) {
  return (
    <AutomationsNavigationContext.Provider value={value}>
      {children}
    </AutomationsNavigationContext.Provider>
  );
}

/** Null outside a workbench, where a surface offers no way into Automations. */
export function useAutomationsNavigation(): AutomationsNavigation | null {
  return useContext(AutomationsNavigationContext);
}
