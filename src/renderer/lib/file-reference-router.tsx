import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  type FileLinkOpenerId,
  type FileLinkTarget,
  buildFileUrl,
} from "../../shared/file-link-openers";
import type { PanelId } from "./types";
import { openFileLink, type FileLinkOpenPort } from "./file-system-operations";
import {
  canonicalWorkbenchFilePath,
  WorkbenchAbsoluteFilePathSchema,
} from "../../shared/workbench-resource-identity";
import type { WorkspaceFileShowChanges } from "@/features/workspace-files/workspace-file-types";
import { isBrowserHtmlFilePath } from "../../shared/browser-url-policy";
import { decideFileReferenceOpen } from "./file-reference-opening";
import type { LinkActivation } from "../../shared/link-opening";
import {
  readFileReferenceOpenTargets,
  openFileReferenceTarget,
} from "./file-reference-open-targets";
import { readWorkspaceFileMetadata, saveWorkspaceFileCopy } from "./workspace-file-operations";
import type { LinkRouter } from "./link-opening";
import { WebLinkNavigationProvider, useLinkOpening } from "./web-link-navigation";
import type { WebLinkNavigation } from "./web-link-context-menu";

export type FileReferenceTarget = FileLinkTarget;

export interface FileReferenceOpenInput {
  readonly hostId?: string;
  readonly kind?: "file" | "directory";
  readonly cwd?: string | null;
  readonly workspaceRoot?: string | null;
  readonly title?: string;
  readonly panelId?: PanelId;
  readonly mode?: "preview" | "durable";
  readonly external?: boolean;
  readonly sidePanel?: boolean;
  readonly previewSource?: boolean;
  readonly activation?: LinkActivation;
  readonly opener?: FileLinkOpenerId;
  readonly isCurrent?: () => boolean;
}

export interface FileReferenceRouterPort {
  readonly openWorkspaceFileTab: (input: {
    cwd?: string | null;
    hostId?: string;
    kind?: "file" | "directory";
    path: string;
    title: string;
    panelId: PanelId;
    mode?: "preview" | "durable";
    workspaceRoot?: string | null;
    location?: Pick<FileLinkTarget, "line" | "column" | "endLine" | "endColumn">;
    showChanges?: WorkspaceFileShowChanges;
    isCurrent?: () => boolean;
  }) => Promise<boolean>;
}

export interface FileReferenceRouter {
  readonly browserAvailable?: boolean;
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
  return await openExternal(target, opener).catch(() => false);
}

export function createFileReferenceRouter({
  port,
  links,
}: {
  readonly port?: FileReferenceRouterPort | null;
  readonly links?: LinkRouter;
}): FileReferenceRouter {
  return {
    browserAvailable: links?.browserAvailable ?? false,
    open: async (target, options) => {
      if (options?.isCurrent?.() === false) return false;
      const resolvedTarget = resolveFileReferenceTarget(
        target,
        options?.cwd ?? options?.workspaceRoot,
      );
      if (!resolvedTarget) return false;
      const hostId = options?.hostId ?? "local";
      let directory = options?.kind === "directory" || /[\\/]$/u.test(target.path);
      if (
        !options?.kind &&
        hostId === "local" &&
        links?.browserAvailable &&
        isBrowserHtmlFilePath(resolvedTarget.path)
      ) {
        const metadata = await readWorkspaceFileMetadata({ hostId, path: resolvedTarget.path });
        directory = !metadata.isFile;
      }
      if (options?.isCurrent?.() === false) return false;
      const decision = decideFileReferenceOpen({
        target: resolvedTarget,
        hostId,
        directory,
        browserAvailable: links?.browserAvailable ?? false,
        sidePanel: options?.sidePanel,
        previewSource: options?.previewSource,
        explicitTarget: options?.external === true || options?.opener !== undefined,
        activation: options?.activation,
      });
      if (decision === "save") {
        const saved = await saveWorkspaceFileCopy({ hostId, path: resolvedTarget.path });
        return saved.path !== null;
      }
      if (decision === "browser")
        return links!.openLink({
          url: buildFileUrl(resolvedTarget),
          hostId,
          initiator: "open_in_browser_bridge",
          source: "manual",
          openTarget: "in-app-browser",
        });
      if (decision === "file-manager")
        return (
          hostId === "local" &&
          openFileReferenceExternally(
            resolvedTarget,
            "fileManager",
            openFileLink,
            options?.isCurrent,
          )
        );
      if (decision === "files" && port) {
        const openedInPanel = await port.openWorkspaceFileTab({
          cwd: options?.cwd,
          hostId,
          kind: options?.kind,
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
        return openedInPanel;
      }
      if (decision === "files" && hostId !== "local") return false;
      if (hostId !== "local") return false;
      if (options?.opener)
        return openFileReferenceExternally(
          resolvedTarget,
          options.opener,
          openFileLink,
          options.isCurrent,
        );
      const targets = await readFileReferenceOpenTargets(resolvedTarget.path);
      if (options?.isCurrent?.() === false || !targets.primary) return false;
      return openFileReferenceTarget(targets.primary, resolvedTarget);
    },
  };
}

export function FileReferenceRouterProvider({
  children,
  openWorkspaceFileTab,
  openBrowserTab,
  openBrowserWindow,
  workspaceRoot = null,
}: {
  readonly children: ReactNode;
  readonly openWorkspaceFileTab?: FileReferenceRouterPort["openWorkspaceFileTab"];
  readonly openBrowserTab?: WebLinkNavigation["openTab"];
  readonly openBrowserWindow?: WebLinkNavigation["openWindow"];
  readonly workspaceRoot?: string | null;
}) {
  const links = useLinkOpening();
  const port = useMemo<FileReferenceRouterPort | null>(() => {
    if (!openWorkspaceFileTab) return null;
    return { openWorkspaceFileTab };
  }, [openWorkspaceFileTab]);
  const router = useMemo(() => createFileReferenceRouter({ port, links }), [port, links]);
  const value = useMemo<FileReferenceRouterContextValue>(
    () => ({
      ...router,
      hostId: "local",
      workspaceRoot: workspaceRoot?.trim() || null,
    }),
    [router, workspaceRoot],
  );
  const webNavigation = useMemo<WebLinkNavigation>(
    () => ({ openTab: openBrowserTab, openWindow: openBrowserWindow }),
    [openBrowserTab, openBrowserWindow],
  );

  return (
    <FileReferenceRouterContext.Provider value={value}>
      <WebLinkNavigationProvider navigation={webNavigation}>{children}</WebLinkNavigationProvider>
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
      browserAvailable: parent.browserAvailable,
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
  const fallbackRouter = useMemo(() => createFileReferenceRouter({}), []);
  return context ?? { ...fallbackRouter, hostId: "local", workspaceRoot: null };
}
