import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  FILE_LINK_OPENER_OPTIONS,
  type FileLinkOpenerId,
  type FileLinkTarget,
} from "../../shared/file-link-openers";
import type { PanelId } from "./types";
import { openFileLink, type FileLinkOpenPort } from "./file-system-operations";
import { useFileLinkOpener } from "./use-file-link-opener";

export type FileReferenceTarget = FileLinkTarget;

export interface FileReferenceOpenInput {
  readonly cwd?: string | null;
  readonly workspaceRoot?: string | null;
  readonly title?: string;
  readonly panelId?: PanelId;
  readonly mode?: "preview" | "durable";
  readonly external?: boolean;
  readonly opener?: FileLinkOpenerId;
}

export interface FileReferenceRouterPort {
  readonly openWorkspaceFileTab: (input: {
    cwd?: string | null;
    hostId?: "local";
    path: string;
    title: string;
    panelId: PanelId;
    mode?: "preview" | "durable";
    workspaceRoot?: string | null;
    location?: Pick<FileLinkTarget, "line" | "column" | "endLine" | "endColumn">;
  }) => Promise<boolean>;
}

export interface FileReferenceRouter {
  readonly open: (
    target: FileReferenceTarget,
    options?: FileReferenceOpenInput,
  ) => Promise<boolean>;
}

interface FileReferenceRouterContextValue extends FileReferenceRouter {
  readonly workspaceRoot: string | null;
}

const FileReferenceRouterContext = createContext<FileReferenceRouterContextValue | null>(null);

function getTargetTitle(target: FileReferenceTarget, title?: string): string {
  const trimmedTitle = title?.trim();
  if (trimmedTitle) return trimmedTitle;

  const pathSegments = target.path.replace(/\\/g, "/").split("/").filter(Boolean);
  return pathSegments.at(-1) ?? target.path;
}

export async function openFileReferenceExternally(
  target: FileReferenceTarget,
  opener: FileLinkOpenerId,
  openExternal: FileLinkOpenPort = openFileLink,
): Promise<boolean> {
  try {
    const opened = await openExternal(target, opener);
    if (opened) return true;
  } catch {
    // Try the deterministic file-manager fallback below.
  }

  if (opener === "fileManager") return false;

  try {
    return await openExternal(target, "fileManager");
  } catch {
    return false;
  }
}

export function createFileReferenceRouter({
  opener,
  port,
}: {
  readonly opener: FileLinkOpenerId;
  readonly port?: FileReferenceRouterPort | null;
}): FileReferenceRouter {
  return {
    open: async (target, options) => {
      const external = options?.external === true;
      if (!external && port) {
        const openedInPanel = await port.openWorkspaceFileTab({
          cwd: options?.cwd,
          hostId: "local",
          path: target.path,
          title: getTargetTitle(target, options?.title),
          panelId: options?.panelId ?? "right",
          mode: options?.mode ?? "preview",
          workspaceRoot: options?.workspaceRoot,
          ...(target.line
            ? {
                location: {
                  line: target.line,
                  ...(target.column ? { column: target.column } : {}),
                  ...(target.endLine ? { endLine: target.endLine } : {}),
                  ...(target.endColumn ? { endColumn: target.endColumn } : {}),
                },
              }
            : {}),
        });
        if (openedInPanel) return true;
      }

      return openFileReferenceExternally(target, options?.opener ?? opener);
    },
  };
}

export function FileReferenceRouterProvider({
  children,
  openWorkspaceFileTab,
  workspaceRoot = null,
}: {
  readonly children: ReactNode;
  readonly openWorkspaceFileTab?: FileReferenceRouterPort["openWorkspaceFileTab"];
  readonly workspaceRoot?: string | null;
}) {
  const { opener } = useFileLinkOpener();
  const port = useMemo<FileReferenceRouterPort | null>(() => {
    if (!openWorkspaceFileTab) return null;
    return { openWorkspaceFileTab };
  }, [openWorkspaceFileTab]);
  const router = useMemo(() => createFileReferenceRouter({ opener, port }), [opener, port]);
  const value = useMemo<FileReferenceRouterContextValue>(
    () => ({
      ...router,
      workspaceRoot: workspaceRoot?.trim() || null,
    }),
    [router, workspaceRoot],
  );

  return (
    <FileReferenceRouterContext.Provider value={value}>
      {children}
    </FileReferenceRouterContext.Provider>
  );
}

export function useFileReferenceRouter(): FileReferenceRouterContextValue {
  const context = useContext(FileReferenceRouterContext);
  const { opener } = useFileLinkOpener();
  const fallbackRouter = useMemo(() => createFileReferenceRouter({ opener }), [opener]);
  return context ?? { ...fallbackRouter, workspaceRoot: null };
}

export function getFileReferenceOpenWithMenuItems() {
  return FILE_LINK_OPENER_OPTIONS.map((option) => ({
    id: `file-reference:open-with:${option.id}`,
    label: option.label,
    iconKey: "window" as const,
  }));
}

export function parseFileReferenceOpenWithMenuId(id: string | null): FileLinkOpenerId | null {
  const prefix = "file-reference:open-with:";
  if (!id?.startsWith(prefix)) return null;
  const candidate = id.slice(prefix.length);
  return FILE_LINK_OPENER_OPTIONS.some((option) => option.id === candidate)
    ? (candidate as FileLinkOpenerId)
    : null;
}
