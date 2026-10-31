import { createContext, useMemo, type ReactNode } from "react";

export interface FileLinkWorkspaceContextValue {
  cwd?: string | null;
  workspacePath?: string | null;
}

export const FileLinkWorkspaceContext = createContext<FileLinkWorkspaceContextValue | undefined>(
  undefined,
);

export function FileLinkWorkspaceProvider({
  children,
  cwd,
  workspacePath,
}: {
  children: ReactNode;
  cwd?: string | null;
  workspacePath?: string | null;
}) {
  const value = useMemo(() => ({ cwd, workspacePath }), [cwd, workspacePath]);
  return (
    <FileLinkWorkspaceContext.Provider value={value}>{children}</FileLinkWorkspaceContext.Provider>
  );
}
