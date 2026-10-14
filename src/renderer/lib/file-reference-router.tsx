import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  FILE_LINK_OPENER_OPTIONS,
  type FileLinkOpenerId,
  type FileLinkTarget,
} from "../../shared/file-link-openers";
import type { PanelId } from "./types";
import { openFileLink, type FileLinkOpenPort } from "./file-system-operations";
import { useFileLinkOpener } from "./use-file-link-opener";
import {
  canonicalWorkbenchFilePath,
  WorkbenchAbsoluteFilePathSchema,
} from "../../shared/workbench-resource-identity";

export type FileReferenceTarget = FileLinkTarget;

export interface FileReferenceOpenInput {
  readonly hostId?: string;
  readonly cwd?: string | null;
  readonly workspaceRoot?: string | null;
  readonly title?: string;
  readonly panelId?: PanelId;
  readonly mode?: "preview" | "durable";
  readonly external?: boolean;
  readonly opener?: FileLinkOpenerId;
  readonly isCurrent?: () => boolean;
}

export interface FileReferenceRouterPort {
  readonly openWorkspaceFileTab: (input: {
    cwd?: string | null;
    hostId?: string;
    path: string;
    title: string;
    panelId: PanelId;
    mode?: "preview" | "durable";
    workspaceRoot?: string | null;
    location?: Pick<FileLinkTarget, "line" | "column" | "endLine" | "endColumn">;
    isCurrent?: () => boolean;
  }) => Promise<boolean>;
}

export interface FileReferenceRouter {
  readonly open: (
    target: FileReferenceTarget,
    options?: FileReferenceOpenInput,
  ) => Promise<boolean>;
}

interface FileReferenceRouterContextValue extends FileReferenceRouter {
  readonly hostId: string;
  readonly workspaceRoot: string | null;
}

const FileReferenceRouterContext = createContext<FileReferenceRouterContextValue | null>(null);

/** Relative native references use the Files directory model without entering a URI decoder. */
export function resolveFileReferenceTarget(
  target: Readonly<FileReferenceTarget>,
  basePath?: string | null,
): FileReferenceTarget | null {
  if (!target.path) return null;
  if (WorkbenchAbsoluteFilePathSchema.safeParse(target.path).success) return target;
  if (!basePath || !WorkbenchAbsoluteFilePathSchema.safeParse(basePath).success) return null;
  try {
    return { ...target, path: canonicalWorkbenchFilePath(target.path, basePath) };
  } catch {
    return null;
  }
}

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
  isCurrent?: () => boolean,
): Promise<boolean> {
  if (isCurrent?.() === false) return false;
  try {
    const opened = await openExternal(target, opener);
    if (opened) return true;
  } catch {
    // Try the deterministic file-manager fallback below.
  }

  if (opener === "fileManager") return false;
  if (isCurrent?.() === false) return false;

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
      if (options?.isCurrent?.() === false) return false;
      const resolvedTarget = resolveFileReferenceTarget(
        target,
        options?.cwd ?? options?.workspaceRoot,
      );
      if (!resolvedTarget) return false;
      const hostId = options?.hostId ?? "local";
      const external = options?.external === true;
      if (!external && port) {
        const openedInPanel = await port.openWorkspaceFileTab({
          cwd: options?.cwd,
          hostId,
          path: resolvedTarget.path,
          title: getTargetTitle(resolvedTarget, options?.title),
          panelId: options?.panelId ?? "right",
          mode: options?.mode ?? "preview",
          workspaceRoot: options?.workspaceRoot,
          ...(options?.isCurrent ? { isCurrent: options.isCurrent } : {}),
          ...(resolvedTarget.line
            ? {
                location: {
                  line: resolvedTarget.line,
                  ...(resolvedTarget.column ? { column: resolvedTarget.column } : {}),
                  ...(resolvedTarget.endLine ? { endLine: resolvedTarget.endLine } : {}),
                  ...(resolvedTarget.endColumn ? { endColumn: resolvedTarget.endColumn } : {}),
                },
              }
            : {}),
        });
        if (openedInPanel) return true;
        if (options?.isCurrent?.() === false) return false;
      }

      if (hostId !== "local") return false;
      return openFileReferenceExternally(
        resolvedTarget,
        options?.opener ?? opener,
        openFileLink,
        options?.isCurrent,
      );
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
      hostId: "local",
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

/** File content inherits its source host while using the owning Workbench router. */
export function FileReferenceHostProvider({
  children,
  hostId,
  workspaceRoot,
}: {
  readonly children: ReactNode;
  readonly hostId: string;
  readonly workspaceRoot: string | null;
}) {
  const parent = useFileReferenceRouter();
  const value = useMemo<FileReferenceRouterContextValue>(
    () => ({
      hostId,
      workspaceRoot,
      open: (target, options) =>
        parent.open(target, { ...options, hostId: options?.hostId ?? hostId }),
    }),
    [hostId, parent, workspaceRoot],
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
  return context ?? { ...fallbackRouter, hostId: "local", workspaceRoot: null };
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
