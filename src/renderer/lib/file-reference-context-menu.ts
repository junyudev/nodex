import type { FileLinkTarget } from "../../shared/file-link-openers";
import { getFileManagerRevealLabel } from "../../shared/file-link-openers";
import type { NativeContextMenuItem } from "../../shared/native-context-menu";
import { showNativeContextMenu } from "./native-context-menu";
import { writeTextToClipboard } from "./clipboard";
import { openExternalUrl } from "./file-system-operations";
import {
  openFileReferenceTarget,
  readFileReferenceOpenTargets,
} from "./file-reference-open-targets";
import {
  readWorkspaceFileGitHubUrl,
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
  includeOpenFile = true,
}: Omit<FileReferenceContextMenuRequest, "x" | "y">): Promise<CapturedFileReferenceContextMenu> {
  const empty: CapturedFileReferenceContextMenu = { items: [], select: async () => undefined };
  if (!isCurrent()) return empty;
  const [targets, github] = await Promise.all([
    hostId === "local"
      ? readFileReferenceOpenTargets(target.path)
      : Promise.resolve({ primary: null, alternatives: [] }),
    readWorkspaceFileGitHubUrl({ hostId, path: target.path, line: target.line }).catch(() => null),
  ]);
  if (!isCurrent()) return empty;
  const actions = new Map<string, () => Promise<unknown>>();
  const item = (
    id: string,
    label: string,
    run: () => Promise<unknown>,
    extras: { iconKey?: "folder" | "copy" | "window"; iconUrl?: string } = {},
  ): NativeContextMenuItem => {
    actions.set(id, run);
    return { id, label, ...extras };
  };
  const items: NativeContextMenuItem[] = [];
  if (includeOpenFile)
    items.push(
      item(
        "file-reference:open",
        "Open file",
        () => open(target, { title: label, mode: "preview" }),
        { iconKey: "folder" },
      ),
    );
  if (targets.primary) {
    const primary = targets.primary;
    items.push(
      item(
        "file-reference:preferred",
        `Open in ${primary.label}`,
        () => openFileReferenceTarget(primary, target),
        { iconUrl: primary.iconUrl },
      ),
    );
    items.push({
      id: "file-reference:open-with",
      label: "Open with",
      type: "submenu",
      iconKey: "window",
      submenu: targets.alternatives.map((destination) =>
        item(
          `file-reference:open-with:${destination.id}`,
          destination.label,
          () => openFileReferenceTarget(destination, target),
          { iconUrl: destination.iconUrl },
        ),
      ),
    });
  }
  if (github)
    items.push(item("file-reference:github", "Open in GitHub", () => openExternalUrl(github)));
  if (targets.primary || github) items.push({ type: "separator" });
  items.push(
    item("file-reference:save", "Save as…", async () => {
      try {
        await saveWorkspaceFileCopy({ hostId, path: target.path });
      } catch {
        if (isCurrent()) toast.danger("Could not save file");
      }
    }),
    item("file-reference:copy-path", "Copy path", () => writeTextToClipboard(target.path), {
      iconKey: "copy",
    }),
    item(
      "file-reference:copy-contents",
      "Copy file contents",
      async () => {
        const result = await readWorkspaceFileText({
          hostId,
          path: target.path,
          maxBytes: 2 * 1024 * 1024,
        });
        if (isCurrent()) await writeTextToClipboard(result.contents);
      },
      { iconKey: "copy" },
    ),
  );
  if (hostId === "local")
    items.push(
      item(
        "file-reference:reveal",
        getFileManagerRevealLabel(navigator.platform),
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
