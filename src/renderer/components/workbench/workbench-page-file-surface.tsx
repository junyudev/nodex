import { useEffect, type JSX } from "react";

import { PageFilesDialog } from "@/components/board/page-stage/page-files-row";
import { LibraryFilesDialog } from "@/components/library/library-files-dialog";
import { toast } from "@/components/ui/toast";
import { PageFileUnavailable, PageFileViewer } from "@/features/page-files/page-file-viewer";
import { WorkspaceFileLoadingState } from "@/features/workspace-files/workspace-file-preview-states";
import { usePageTargetReadModel } from "@/lib/block-reference-queries";
import { openExternalUrl } from "@/lib/file-system-operations";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { openModal } from "@/lib/modal-registry";
import { usePresentedPageTitle } from "@/lib/page-title-projection-context";
import { usePageFile, usePageFileAtPath } from "@/lib/use-library-files";
import type { ContentRoutingContext } from "../../../shared/content-routing-context";
import type {
  WorkbenchPageFileSurfaceConfig,
  WorkbenchSurfaceDescriptor,
} from "../../../shared/workbench-scene";

export interface WorkbenchPageFileSurfaceProps {
  readonly surface: Extract<WorkbenchSurfaceDescriptor, { readonly kind: "page_file" }>;
  readonly isActive: boolean;
  readonly onOpenPage: (input: {
    routingContext: ContentRoutingContext;
    pageId: string;
    title: string;
  }) => void;
  readonly onUpdateConfig: (
    patch: Partial<
      Pick<WorkbenchPageFileSurfaceConfig, "fileId" | "logicalPath" | "titleSnapshot">
    >,
  ) => void;
  readonly onPinPreview: () => void;
  readonly onClose: () => void;
}

const fileName = (path: string | null, fallback: string): string =>
  path?.split("/").at(-1) ?? fallback;

/**
 * A Page File tab follows its Page entry: a renamed path keeps the tab, and a path whose File
 * was replaced, as an Agent does when it attaches a new report, moves the tab to the new File.
 */
export function WorkbenchPageFileSurface({
  surface,
  onOpenPage,
  onUpdateConfig,
  onPinPreview,
}: WorkbenchPageFileSurfaceProps): JSX.Element {
  const appHandle = useScopeHandle(appScope);
  const { routingContext, pageId, fileId, logicalPath } = surface.config;
  const current = usePageFile(routingContext, pageId, fileId);
  const replaced = usePageFileAtPath(
    routingContext,
    pageId,
    current.error && logicalPath ? logicalPath : null,
  );
  const item = current.item ?? null;
  const page = usePageTargetReadModel(routingContext, pageId);
  const pageTitle = usePresentedPageTitle(
    pageId,
    page.data?.status === "available" ? page.data.page.title.trim() || "Untitled" : "Page",
  );

  const followedPath = item ? (item.logical_path ?? null) : null;
  const followedName = item ? fileName(item.logical_path ?? null, item.file.default_name) : null;
  const replacementId = replaced.item?.file.file_id ?? null;
  useEffect(() => {
    if (followedName === null) return;
    if (followedPath === logicalPath && followedName === surface.titleSnapshot) return;
    onUpdateConfig({ logicalPath: followedPath, titleSnapshot: followedName });
  }, [followedName, followedPath, logicalPath, onUpdateConfig, surface.titleSnapshot]);
  useEffect(() => {
    if (replacementId && replacementId !== fileId) onUpdateConfig({ fileId: replacementId });
  }, [fileId, onUpdateConfig, replacementId]);

  const openPage = () => onOpenPage({ routingContext, pageId, title: pageTitle });

  if (!item) {
    const unresolved = current.error && !(logicalPath && (replaced.loading || replaced.item));
    return unresolved ? (
      <PageFileUnavailable pageTitle={pageTitle} onOpenPage={openPage} />
    ) : (
      <WorkspaceFileLoadingState />
    );
  }

  return (
    <PageFileViewer
      routingContext={routingContext}
      pageId={pageId}
      pageTitle={pageTitle}
      item={item}
      onOpenPage={openPage}
      onKeep={onPinPreview}
      onManage={() =>
        openModal(appHandle, PageFilesDialog, {
          routingContext,
          pageId,
          initialFileId: item.file.file_id,
          onChanged: async () => {
            await current.refresh();
          },
        })
      }
      onOpenInLibrary={() =>
        openModal(appHandle, LibraryFilesDialog, {
          routingContext,
          initialFileId: item.file.file_id,
        })
      }
      onOpenExternalLink={(url) =>
        void openExternalUrl(url).catch(() => toast.danger("Unable to open external link"))
      }
    />
  );
}
