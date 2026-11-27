import { createContext, useContext, type ReactNode } from "react";

const GitHubSettingsNavigationContext = createContext<(() => void) | null>(null);

/** The current Workbench window owns settings navigation; GitHub surfaces ask it to open GitHub. */
export function GitHubSettingsNavigationProvider({
  openGitHubSettings,
  children,
}: {
  readonly openGitHubSettings: () => void;
  readonly children: ReactNode;
}) {
  return (
    <GitHubSettingsNavigationContext value={openGitHubSettings}>
      {children}
    </GitHubSettingsNavigationContext>
  );
}

export const useGitHubSettingsNavigation = () => useContext(GitHubSettingsNavigationContext);
