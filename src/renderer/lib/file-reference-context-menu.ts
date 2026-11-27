import { getIntl } from "@/lib/i18n";
import type { FileLinkTarget } from "../../shared/file-link-openers";
import { getFileManagerRevealMessage } from "../../shared/file-link-openers";
import type {
  NativeContextMenuBaseItem,
  NativeContextMenuItem,
} from "../../shared/native-context-menu";
import { showNativeContextMenu } from "./native-context-menu";
import { writeTextToClipboard } from "./clipboard";
import { openLink } from "./link-opening";
import { isBrowserHtmlFilePath } from "../../shared/browser-url-policy";
import {
  openFileReferenceTarget,
  readFileReferenceOpenTargets,
} from "./file-reference-open-targets";
import {
  readWorkspaceFileGitHubUrl,
  readWorkspaceFileMetadata,
  readWorkspaceFileText,
  saveWorkspaceFileCopy,
} from "./workspace-file-operations";
import type { FileReferenceRouter } from "./file-reference-router";
import { toast } from "@/components/ui/toast";

export interface FileReferenceContextMenuRequest {
  readonly hostId?: string;
  readonly target: FileLinkTarget;
  readonly label: string;
  readonly open: FileReferenceRouter["open"];
  readonly x: number;
  readonly y: number;
  readonly isCurrent?: () => boolean;
  readonly includeOpenFile?: boolean;
  readonly sidePanel?: boolean;
  readonly browserAvailable?: boolean;
  readonly openLink?: typeof openLink;
}

export interface CapturedFileReferenceContextMenu {
  readonly items: NativeContextMenuItem[];
  readonly select: (id: string | null) => Promise<void>;
}

/** Query actual destinations once, retaining their callbacks and the source lifetime. */
export async function buildFileReferenceContextMenu({
  hostId = "local",
  target,
  label,
  open,
  isCurrent = () => true,
  includeOpenFile,
  sidePanel = includeOpenFile ?? true,
  browserAvailable = false,
  openLink: openUrl = openLink,
}: Omit<FileReferenceContextMenuRequest, "x" | "y">): Promise<CapturedFileReferenceContextMenu> {
  const empty: CapturedFileReferenceContextMenu = { items: [], select: async () => undefined };
  if (!isCurrent()) return empty;
  const maxCopyBytes = 2 * 1024 * 1024;
  const [targets, github, metadata] = await Promise.all([
    hostId === "local"
      ? readFileReferenceOpenTargets(target.path)
      : Promise.resolve({ primary: null, alternatives: [] }),
    readWorkspaceFileGitHubUrl({ hostId, path: target.path, line: target.line }).catch(() => null),
    readWorkspaceFileMetadata({
      hostId,
      path: target.path,
      contentSampleMaxFileBytes: maxCopyBytes,
    }).catch(() => null),
  ]);
  if (!isCurrent()) return empty;
  const actions = new Map<string, () => Promise<unknown>>();
  const item = (
    id: string,
    label: string,
    run: () => Promise<unknown>,
    extras: Pick<NativeContextMenuBaseItem, "iconKey" | "iconUrl">,
  ): NativeContextMenuItem => {
    actions.set(id, run);
    return { id, label, ...extras };
  };
  const items: NativeContextMenuItem[] = [];
  if (sidePanel)
    items.push(
      item(
        "file-reference:open",
        getIntl().formatMessage({
          id: "lib.fileReferenceContextMenu.openFile",
          defaultMessage: "Open file",
        }),
        () => open(target, { hostId, title: label, mode: "preview", sidePanel: true }),
        { iconKey: "openIn" },
      ),
    );
  if (!sidePanel && hostId === "local" && browserAvailable && isBrowserHtmlFilePath(target.path))
    items.push(
      item(
        "file-reference:browser",
        getIntl().formatMessage({
          id: "lib.fileReferenceContextMenu.viewInBrowser",
          defaultMessage: "View in browser",
        }),
        () => open(target, { hostId, sidePanel: false }),
        { iconKey: "openIn" },
      ),
    );
  if (targets.primary) {
    const primary = targets.primary;
    items.push(
      item(
        "file-reference:preferred",
        getIntl().formatMessage(
          { id: "lib.fileReferenceContextMenu.openInApp", defaultMessage: "Open in {app}" },
          { app: primary.label },
        ),
        () => openFileReferenceTarget(primary, target),
        { iconUrl: primary.iconUrl, iconKey: "openIn" },
      ),
    );
  }
  if (targets.alternatives.length > 0) {
    items.push({
      id: "file-reference:open-with",
      label: getIntl().formatMessage({
        id: "lib.fileReferenceContextMenu.openWith",
        defaultMessage: "Open with",
      }),
      type: "submenu",
      iconKey: "window",
      submenu: targets.alternatives.map((destination) =>
        item(
          `file-reference:open-with:${destination.id}`,
          destination.label,
          () => openFileReferenceTarget(destination, target),
          { iconUrl: destination.iconUrl, iconKey: "openIn" },
        ),
      ),
    });
  }
  if (github)
    items.push(
      item(
        "file-reference:github",
        getIntl().formatMessage({
          id: "lib.fileReferenceContextMenu.openInGitHub",
          defaultMessage: "Open in GitHub",
        }),
        () => openUrl({ url: github, hostId, initiator: "file_context_menu" }),
        { iconKey: "openIn" },
      ),
    );
  if (items.length > 0) items.push({ type: "separator" });
  items.push(
    item(
      "file-reference:save",
      getIntl().formatMessage({
        id: "lib.fileReferenceContextMenu.saveAs",
        defaultMessage: "Save a copy",
      }),
      async () => {
        try {
          await saveWorkspaceFileCopy({ hostId, path: target.path });
        } catch {
          if (isCurrent())
            toast.danger(
              getIntl().formatMessage({
                id: "lib.fileReferenceContextMenu.saveFailed",
                defaultMessage: "Could not save file",
              }),
            );
        }
      },
      { iconKey: "download" },
    ),
    item(
      "file-reference:copy-path",
      getIntl().formatMessage({
        id: "lib.fileReferenceContextMenu.copyPath",
        defaultMessage: "Copy path",
      }),
      () => writeTextToClipboard(target.path),
      {
        iconKey: "copy",
      },
    ),
  );
  if (metadata?.contentKind === "text")
    items.push(
      item(
        "file-reference:copy-contents",
        getIntl().formatMessage({
          id: "lib.fileReferenceContextMenu.copyContents",
          defaultMessage: "Copy file contents",
        }),
        async () => {
          try {
            const result = await readWorkspaceFileText({
              hostId,
              path: target.path,
              maxBytes: maxCopyBytes,
            });
            if (isCurrent()) await writeTextToClipboard(result.contents);
          } catch {
            if (isCurrent())
              toast.danger(
                getIntl().formatMessage({
                  id: "lib.fileReferenceContextMenu.copyContentsFailed",
                  defaultMessage: "Could not copy file contents",
                }),
              );
          }
        },
        { iconKey: "copy" },
      ),
    );
  if (hostId === "local")
    items.push(
      item(
        "file-reference:reveal",
        getIntl().formatMessage(getFileManagerRevealMessage(navigator.platform)),
        () => open(target, { external: true, opener: "fileManager" }),
        { iconKey: "folder" },
      ),
    );
  return {
    items,
    select: async (id) => {
      if (!id || !isCurrent()) return;
      await actions.get(id)?.();
    },
  };
}

/** Anchor and editor menus share the same available destinations and captured actions. */
export async function openFileReferenceContextMenu(
  request: FileReferenceContextMenuRequest,
): Promise<void> {
  const menu = await buildFileReferenceContextMenu(request);
  if (menu.items.length === 0 || request.isCurrent?.() === false) return;
  await menu.select(await showNativeContextMenu(menu.items, { x: request.x, y: request.y }));
}
