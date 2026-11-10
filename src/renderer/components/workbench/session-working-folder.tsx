import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { ProjectSession } from "@/lib/types";
import { readableIpcError } from "@/lib/ipc-error-message";
import { ensureSessionFolder } from "@/lib/session-folders";

export const sessionFolderQueryKey = (sessionId: string) => ["session-folder", sessionId] as const;

/**
 * Renders a surface that works in a chat's folder. A chat without a Project gets its Chat folder
 * here, the first time a Terminal or Files needs one, and the first message then runs in it too.
 */
export function SessionWorkingFolder({
  session,
  folder,
  children,
}: {
  session: Pick<ProjectSession, "id" | "projectId">;
  /** The folder the chat already works in, when it has one. */
  folder: string | undefined;
  children: (folder: string) => ReactNode;
}) {
  const ensured = useQuery({
    queryKey: sessionFolderQueryKey(session.id),
    queryFn: () => ensureSessionFolder(session.id),
    enabled: !folder && session.projectId === null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const path = folder ?? ensured.data?.path;
  if (path) return children(path);
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-token-main-surface-primary px-3 text-center text-sm text-token-text-secondary">
      {ensured.isError
        ? readableIpcError(ensured.error) || "This chat's folder is unavailable"
        : ensured.fetchStatus === "idle"
          ? "This chat has no folder to work in"
          : null}
    </div>
  );
}
