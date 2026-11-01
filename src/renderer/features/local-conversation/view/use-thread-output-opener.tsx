import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { ConnectorFallbackIcon, ConnectorGlobeIcon, PluginsIcon } from "@/components/shared/icons";
import { ColorfulFileResourceIcon } from "@/components/shared/file-resource-icon";
import { ImagePreviewDialog } from "@/features/user-attachment-image-editor";
import { resolveImageDisplaySource } from "@/lib/content-image";
import { openFileReferenceContextMenu } from "@/lib/file-reference-context-menu";
import { useFileReferenceRouter, type FileReferenceRouter } from "@/lib/file-reference-router";
import { openPathWithDefaultApplication } from "@/lib/file-system-operations";
import { openWebLinkContextMenu } from "@/lib/web-link-context-menu";
import { useWebLinkNavigation } from "@/lib/web-link-navigation";
import { cn } from "@/lib/utils";
import {
  describeThreadOutput,
  resolveThreadOutputOpenAction,
} from "../projection/thread-output-presentation";
import type { ThreadSummaryPanelOutputRow } from "../projection/thread-summary-panel-output-model";

export interface ThreadOutputScope {
  readonly hostId: string;
  readonly cwd?: string | null;
  readonly workspaceRoot?: string | null;
}

interface ImagePreview {
  readonly src: string;
  readonly alt: string;
  readonly returnFocus: HTMLElement | null;
}

/** File-type artwork for files, and the established resource glyph for web outputs. */
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

/**
 * Every surface that lists a Thread output opens it the same way: images in the in-place
 * viewer, local HTML rendered by the default browser, web resources as links, and every
 * other file in Files on the output's own host. The context menu offers the full set of
 * file or link destinations.
 */
export function useThreadOutputOpener({ hostId, cwd, workspaceRoot }: ThreadOutputScope): {
  readonly open: (
    row: ThreadSummaryPanelOutputRow,
    origin?: HTMLElement | null,
  ) => Promise<boolean>;
  readonly openContextMenu: (
    row: ThreadSummaryPanelOutputRow,
    event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
  ) => void;
  readonly preview: ReactNode;
} {
  const files = useFileReferenceRouter();
  const webNavigation = useWebLinkNavigation();
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null);
  const openFile: FileReferenceRouter["open"] = (target, options) =>
    files.open(target, { hostId, cwd, workspaceRoot, ...options });

  const open = async (row: ThreadSummaryPanelOutputRow, origin?: HTMLElement | null) => {
    const action = resolveThreadOutputOpenAction(row, hostId);
    if (action.type === "web") {
      window.open(action.url, "_blank", "noopener,noreferrer");
      return true;
    }
    if (action.type === "image-preview") {
      const src = resolveImageDisplaySource(action.path, { allowLocalPath: true });
      if (src) {
        setImagePreview({ src, alt: row.label, returnFocus: origin ?? null });
        return true;
      }
    }
    if (
      action.type === "default-app" &&
      (await openPathWithDefaultApplication(action.path).catch(() => false))
    )
      return true;
    return await openFile({ path: action.path }, { title: describeThreadOutput(row, cwd).title });
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
      ...point,
      isCurrent,
    }).catch(() => undefined);
  };

  const preview = imagePreview ? (
    <ImagePreviewDialog
      open
      onOpenChange={(next) => {
        if (!next) setImagePreview(null);
      }}
      src={imagePreview.src}
      alt={imagePreview.alt}
      allowLocalPath
      finalFocus={() => {
        imagePreview.returnFocus?.focus();
        return false;
      }}
    />
  ) : null;

  return { open, openContextMenu, preview };
}

/** The keyboard spelling of a context-menu request on a focused output. */
export function isContextMenuKey(event: KeyboardEvent<HTMLElement>): boolean {
  return event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
}
