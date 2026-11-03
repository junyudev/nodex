import { useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { ConnectorFallbackIcon, ConnectorGlobeIcon, PluginsIcon } from "@/components/shared/icons";
import { ColorfulFileResourceIcon } from "@/components/shared/file-resource-icon";
import { getFileManagerName } from "../../../../shared/file-link-openers";
import type { LinkActivation } from "../../../../shared/link-opening";
import { snapshotLinkActivation } from "@/lib/link-activation";
import { openLink } from "@/lib/link-opening";
import { writeTextToClipboard } from "@/lib/clipboard";
import { openFileReferenceContextMenu } from "@/lib/file-reference-context-menu";
import {
  resolveFileReferenceTarget,
  useFileReferenceRouter,
  type FileReferenceRouter,
} from "@/lib/file-reference-router";
import {
  openFileReferenceTarget,
  readFileReferenceOpenTargets,
  type NativeMenuTarget,
} from "@/lib/file-reference-open-targets";
import { saveWorkspaceFileCopy } from "@/lib/workspace-file-operations";
import { readSystemDefaultBrowser } from "@/lib/file-system-operations";
import { openWebLinkContextMenu } from "@/lib/web-link-context-menu";
import { useLinkOpening, useWebLinkNavigation } from "@/lib/web-link-navigation";
import { cn } from "@/lib/utils";
import {
  describeThreadOutput,
  resolveThreadOutputOpenAction,
} from "../projection/thread-output-presentation";
import type { ThreadSummaryPanelOutputRow } from "../projection/thread-summary-panel-output-model";

export interface ThreadOutputNativeBrowserTarget {
  readonly id: string;
  readonly label: string;
  readonly iconUrl?: string;
  readonly appPath?: string;
  readonly isSystemDefault: boolean;
  readonly open: (url: string) => Promise<boolean>;
}
export interface ThreadOutputScope {
  readonly hostId: string;
  readonly cwd?: string | null;
  readonly workspaceRoot?: string | null;
  /** Native browser discovery belongs to the desktop shell, not output presentation. */
  readonly readNativeBrowserTargets?: () => Promise<readonly ThreadOutputNativeBrowserTarget[]>;
}
export interface ThreadOutputOpenInItem {
  readonly id: string;
  readonly kind: "preview" | "native" | "reveal" | "download" | "copy";
  readonly label: string;
  readonly iconUrl?: string;
  readonly appPath?: string;
  readonly isSystemDefault?: boolean;
  readonly open: () => Promise<boolean>;
}
export interface ThreadOutputOpenInMenu {
  readonly items: readonly ThreadOutputOpenInItem[];
  readonly isLoading: boolean;
  readonly error: Error | null;
}

export function ThreadOutputIcon({
  row,
  className,
}: {
  readonly row: ThreadSummaryPanelOutputRow;
  readonly className?: string;
}) {
  const iconPath = describeThreadOutput(row).iconPath;
  if (iconPath)
    return <ColorfulFileResourceIcon path={iconPath} className={cn("shrink-0", className)} />;
  const Icon =
    row.kind === "google-drive"
      ? ConnectorFallbackIcon
      : row.kind === "appgen-app"
        ? PluginsIcon
        : ConnectorGlobeIcon;
  return <Icon className={cn("shrink-0", className)} aria-hidden />;
}

/** Body actions and explicit menu choices share the output's captured host and directory. */
export function useThreadOutputOpener(scope: ThreadOutputScope) {
  const { hostId, cwd, workspaceRoot } = scope;
  const files = useFileReferenceRouter();
  const links = useLinkOpening();
  const webNavigation = useWebLinkNavigation();
  const openUrl = links?.openLink ?? openLink;
  const readNativeBrowserTargets =
    scope.readNativeBrowserTargets ??
    (async (): Promise<readonly ThreadOutputNativeBrowserTarget[]> => {
      const browser = await readSystemDefaultBrowser();
      if (!browser) return [];
      return [
        {
          id: "external-browser",
          label: browser.name,
          ...(browser.iconDataUrl ? { iconUrl: browser.iconDataUrl } : {}),
          ...(browser.appPath ? { appPath: browser.appPath } : {}),
          isSystemDefault: true,
          open: (url) =>
            openUrl({ url, hostId, initiator: "mcp_app_resource", openTarget: "external-browser" }),
        },
      ];
    });
  const openFile: FileReferenceRouter["open"] = (target, options) =>
    files.open(target, { hostId, cwd, workspaceRoot, sidePanel: true, ...options });

  const open = async (
    row: ThreadSummaryPanelOutputRow,
    _origin?: HTMLElement | null,
    activation?: LinkActivation,
  ): Promise<boolean> => {
    const action = resolveThreadOutputOpenAction(row, hostId);
    if (action.type === "web")
      return openUrl({ url: action.url, hostId, initiator: "mcp_app_resource", activation });
    return openFile({ path: action.path }, { title: describeThreadOutput(row, cwd).title });
  };
  const openFromEvent = (
    row: ThreadSummaryPanelOutputRow,
    event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    return open(row, event.currentTarget, snapshotLinkActivation(event));
  };
  const getOpenInMenu = async (
    row: ThreadSummaryPanelOutputRow,
  ): Promise<readonly ThreadOutputOpenInItem[]> => {
    const action = resolveThreadOutputOpenAction(row, hostId);
    if (action.type === "web") {
      const native = await readNativeBrowserTargets();
      return [
        ...(links?.browserAvailable
          ? [
              {
                id: "in-app-browser",
                kind: "preview" as const,
                label: "Nodex",
                open: () =>
                  openUrl({
                    url: action.url,
                    hostId,
                    initiator: "mcp_app_resource",
                    openTarget: "in-app-browser",
                  }),
              },
            ]
          : []),
        ...native.map((target) => ({
          ...target,
          kind: "native" as const,
          open: () => target.open(action.url),
        })),
        ...(!native.length
          ? [
              {
                id: "external-browser",
                kind: "native" as const,
                label: "Default browser",
                isSystemDefault: true,
                open: () =>
                  openUrl({
                    url: action.url,
                    hostId,
                    initiator: "mcp_app_resource",
                    openTarget: "external-browser",
                  }),
              },
            ]
          : []),
        {
          id: "copy-link",
          kind: "copy",
          label: "Copy link",
          open: async () => {
            await writeTextToClipboard(action.url);
            return true;
          },
        },
      ];
    }
    const target = resolveFileReferenceTarget({ path: action.path }, cwd ?? workspaceRoot);
    if (!target) return [];
    const native =
      hostId === "local" ? await readFileReferenceOpenTargets(target.path) : { alternatives: [] };
    const nativeItem = (destination: NativeMenuTarget): ThreadOutputOpenInItem => ({
      ...destination,
      kind: "native",
      isSystemDefault: destination.isSystemDefault ?? destination.systemDefault ?? false,
      open: () => openFileReferenceTarget(destination, target),
    });
    const manager = getFileManagerName(navigator.platform);
    return [
      {
        id: "preview",
        kind: "preview",
        label: "Nodex",
        open: () =>
          openFile(target, { previewSource: true, title: describeThreadOutput(row, cwd).title }),
      },
      ...native.alternatives.filter((target) => target.opener !== "fileManager").map(nativeItem),
      ...(hostId === "local"
        ? [
            {
              id: "reveal",
              kind: "reveal" as const,
              label: `Show in ${manager}`,
              open: () => openFile(target, { external: true, opener: "fileManager" }),
            },
            {
              id: "download",
              kind: "download" as const,
              label: "Download a copy",
              open: async () =>
                (await saveWorkspaceFileCopy({ hostId, path: target.path })).path !== null,
            },
          ]
        : []),
    ];
  };
  const openContextMenu = (
    row: ThreadSummaryPanelOutputRow,
    event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
  ) => {
    const element = event.currentTarget;
    const point =
      "clientX" in event
        ? { x: event.clientX, y: event.clientY }
        : { x: element.getBoundingClientRect().left, y: element.getBoundingClientRect().bottom };
    const isCurrent = () => element.isConnected && !element.closest("[inert]");
    const action = resolveThreadOutputOpenAction(row, hostId);
    event.preventDefault();
    event.stopPropagation();
    if (action.type === "web") {
      void openWebLinkContextMenu({
        url: action.url,
        navigation: webNavigation,
        ...point,
        isCurrent,
      }).catch(() => undefined);
      return;
    }
    void openFileReferenceContextMenu({
      hostId,
      target: { path: action.path },
      label: describeThreadOutput(row, cwd).title,
      open: openFile,
      sidePanel: true,
      browserAvailable: links?.browserAvailable,
      openLink: openUrl,
      ...point,
      isCurrent,
    }).catch(() => undefined);
  };
  return { open, openFromEvent, openContextMenu, getOpenInMenu, preview: null as ReactNode };
}

/** Load on dropdown disclosure; keep loading/error state out of the card's visual implementation. */
export function useThreadOutputOpenInMenu(
  row: ThreadSummaryPanelOutputRow,
  scope: ThreadOutputScope,
) {
  const opener = useThreadOutputOpener(scope);
  const identity = JSON.stringify([
    row.id,
    resolveThreadOutputOpenAction(row, scope.hostId),
    scope.hostId,
    scope.cwd,
    scope.workspaceRoot,
  ]);
  const request = useRef(0);
  const empty: ThreadOutputOpenInMenu = { items: [], isLoading: false, error: null };
  const [menu, setMenu] = useState<ThreadOutputOpenInMenu & { identity: string; request: number }>({
    ...empty,
    identity,
    request: 0,
  });
  const load = async () => {
    const generation = ++request.current;
    setMenu({ items: [], isLoading: true, error: null, identity, request: generation });
    try {
      const items = await opener.getOpenInMenu(row);
      setMenu((current) =>
        current.request === generation ? { ...current, items, isLoading: false } : current,
      );
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      setMenu((current) =>
        current.request === generation
          ? {
              ...current,
              isLoading: false,
              error,
            }
          : current,
      );
    }
  };
  const visible = menu.identity === identity ? menu : empty;
  return { items: visible.items, isLoading: visible.isLoading, error: visible.error, load };
}
export function isContextMenuKey(event: KeyboardEvent<HTMLElement>): boolean {
  return event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
}
