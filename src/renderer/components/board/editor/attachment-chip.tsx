import { useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import { createReactInlineContentSpec } from "@blocknote/react";
import { Link2 } from "@/components/shared/icons/generic-icons";

import {
  useBlockReferenceHostRuntime,
  type BlockReferenceHostRuntime,
} from "@/components/block-documents/block-reference-runtime-context";
import {
  NodexContextMenuContent,
  NodexContextMenuItem,
  NodexContextMenuPortal,
  NodexContextMenuRoot,
  NodexContextMenuTrigger,
} from "@/components/ui/context-menu";
import { toast } from "@/components/ui/toast";
import { NodexTooltip } from "@/components/ui/tooltip";
import { LibraryFileViewerDialog } from "@/features/page-files/library-file-viewer-dialog";
import { PageFileImagePreview } from "@/features/page-files/page-file-image-preview";
import { pageFilePreviewsInPlace, resolvePageFileViewKind } from "@/lib/page-file-view-kind";
import { resolveManagedAssetPath } from "@/lib/assets";
import { writeTextToClipboard } from "@/lib/clipboard";
import { openFileReferenceContextMenu } from "@/lib/file-reference-context-menu";
import { useFileReferenceRouter, type FileReferenceRouter } from "@/lib/file-reference-router";
import { appScope, useScopeHandle, type ScopeHandle } from "@/lib/maitai";
import { openModal } from "@/lib/modal-registry";
import { showNativeContextMenu } from "@/lib/native-context-menu";
import { attachmentInlineContentConfig } from "../../../../shared/block-documents/blocknote-schema-config";
import { getFileManagerRevealLabel } from "../../../../shared/file-link-openers";
import { parseFileSource } from "../../../../shared/file-resources";
import { AttachmentResourceIcon } from "../attachment-resource-icon";
import { InlineReferenceVisual } from "../inline-reference-visual";
import { MentionInlineFocusAffordance } from "../mention-inline-focus-affordance";
import {
  describeAttachment,
  resolveAttachmentDestination,
  type AttachmentDestination,
  type AttachmentReferenceProps,
} from "./attachment-reference";
import {
  useFilePlacementRuntime,
  useFileReadSnapshot,
  type FilePlacementRuntime,
} from "./file-runtime";

export interface AttachmentProps extends AttachmentReferenceProps {
  readonly origin?: string;
}

type OpenMode = "preview" | "durable";

const ATTACHMENT_INLINE_LABEL_LIMIT = 48;

export function getAttachmentLabel(
  props: Pick<AttachmentProps, "kind" | "name">,
  maxLength = ATTACHMENT_INLINE_LABEL_LIMIT,
): string {
  const base = props.name.trim();
  const fallback = props.kind === "text" ? "Pasted text" : "Untitled attachment";
  const label = base.length > 0 ? base : fallback;
  return label.length > maxLength ? `${label.slice(0, maxLength).trimEnd()}...` : label;
}

interface AttachmentOpenPorts {
  readonly host: BlockReferenceHostRuntime | null;
  readonly router: FileReferenceRouter;
  readonly appHandle: ScopeHandle;
}

/** A saved copy from an older surface lives at a local path only this computer can resolve. */
const resolveLocalPath = async (
  destination: Extract<AttachmentDestination, { kind: "local-path" | "managed-asset" }>,
): Promise<string | null> =>
  destination.kind === "local-path"
    ? destination.path
    : await resolveManagedAssetPath(destination.source);

async function openAttachment(
  destination: AttachmentDestination,
  title: string,
  mode: OpenMode,
  { host, router, appHandle }: AttachmentOpenPorts,
): Promise<void> {
  if (destination.kind === "none") return;
  if (destination.kind === "page-file") {
    await host?.openPageFile?.({
      routingContext: destination.routingContext,
      pageId: destination.pageId,
      fileId: destination.fileId,
      logicalPath: null,
      title,
      openMode: mode,
    });
    return;
  }
  if (destination.kind === "file-viewer") {
    openModal(appHandle, LibraryFileViewerDialog, {
      authority: destination.authority,
      fileId: destination.fileId,
      name: title,
    });
    return;
  }
  const path = await resolveLocalPath(destination);
  const opened = path
    ? await router.open(
        { path },
        {
          hostId: "local",
          kind: destination.directory ? "directory" : "file",
          title,
          mode,
        },
      )
    : false;
  if (!opened) toast.danger(`Couldn’t open ${title}`);
}

/** Linked files share every local file reference's menu; a folder can only be shown or copied. */
async function openLocalAttachmentMenu(
  event: ReactMouseEvent<HTMLElement>,
  destination: Extract<AttachmentDestination, { kind: "local-path" | "managed-asset" }>,
  title: string,
  router: FileReferenceRouter,
): Promise<void> {
  const point = { x: event.clientX, y: event.clientY };
  const path = await resolveLocalPath(destination);
  if (!path) return;
  if (!destination.directory) {
    await openFileReferenceContextMenu({
      hostId: "local",
      target: { path },
      label: title,
      open: router.open,
      browserAvailable: router.browserAvailable,
      ...point,
    });
    return;
  }
  const selected = await showNativeContextMenu(
    [
      { id: "reveal", label: getFileManagerRevealLabel(navigator.platform), iconKey: "folder" },
      { id: "copy-path", label: "Copy path", iconKey: "copy" },
    ],
    point,
  );
  if (selected === "reveal") {
    await router.open({ path }, { hostId: "local", kind: "directory", title });
  } else if (selected === "copy-path") {
    await writeTextToClipboard(path);
  }
}

/** A Library File's actions, in the same words as the Page's Files list. */
function LibraryFileMenu({
  chip,
  destination,
  runtime,
  source,
  name,
  open,
  onOpenChange,
}: {
  readonly chip: ReactElement;
  readonly destination: Extract<AttachmentDestination, { kind: "page-file" | "file-viewer" }>;
  readonly runtime: FilePlacementRuntime | null;
  readonly source: string;
  readonly name: string;
  readonly open: (mode: OpenMode) => void;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const save = async (): Promise<void> => {
    if (!runtime) return;
    try {
      await runtime.save(source, name);
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Couldn’t save File");
    }
  };
  return (
    <NodexContextMenuRoot onOpenChange={onOpenChange}>
      <NodexContextMenuTrigger>{chip}</NodexContextMenuTrigger>
      <NodexContextMenuPortal>
        <NodexContextMenuContent finalFocus={false} data-attachment-menu="true">
          <NodexContextMenuItem onSelect={() => open("preview")}>Open</NodexContextMenuItem>
          {destination.kind === "page-file" ? (
            <NodexContextMenuItem onSelect={() => open("durable")}>
              Open in new tab
            </NodexContextMenuItem>
          ) : null}
          <NodexContextMenuItem onSelect={() => void save()}>Save…</NodexContextMenuItem>
          <NodexContextMenuItem onSelect={() => void writeTextToClipboard(source)}>
            Copy reference
          </NodexContextMenuItem>
        </NodexContextMenuContent>
      </NodexContextMenuPortal>
    </NodexContextMenuRoot>
  );
}

/**
 * An attachment is a reference to a File, read like a Page mention: clicking or pressing Enter
 * opens the File where it is best read, and its context menu holds the File's other actions.
 */
export function AttachmentInlineContent({
  inlineContent,
}: {
  inlineContent: { props: AttachmentProps };
}) {
  const host = useBlockReferenceHostRuntime();
  const router = useFileReferenceRouter();
  const appHandle = useScopeHandle(appScope);
  const fileRuntime = useFilePlacementRuntime();
  const [menuOpen, setMenuOpen] = useState(false);
  const isLibraryFile = parseFileSource(inlineContent.props.source) !== null;
  const { metadata } = useFileReadSnapshot(fileRuntime, inlineContent.props.source, {
    metadata: isLibraryFile,
  });
  const resolvedProps = useMemo<AttachmentProps>(() => {
    if (!metadata) return inlineContent.props;
    return {
      ...inlineContent.props,
      name: metadata.default_name || inlineContent.props.name,
      mimeType: metadata.mime_type,
      bytes: metadata.byte_length,
    };
  }, [inlineContent.props, metadata]);
  const label = getAttachmentLabel(resolvedProps);
  const summary = describeAttachment(resolvedProps);
  const destination = resolveAttachmentDestination({
    attachment: resolvedProps,
    authority: fileRuntime?.authority ?? null,
    canOpenPageFile: Boolean(host?.openPageFile),
  });
  const canOpen = destination.kind !== "none";
  // An image of the Page is looked at over it, exactly as from the Page's Files.
  const previewsInPlace =
    destination.kind === "page-file" &&
    pageFilePreviewsInPlace(
      resolvePageFileViewKind({ name: summary.title, mimeType: resolvedProps.mimeType ?? "" }),
    );
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false);
  const open = (mode: OpenMode): void => {
    if (mode === "preview" && previewsInPlace) {
      setImagePreviewOpen(true);
      return;
    }
    void openAttachment(destination, summary.title, mode, { host, router, appHandle }).catch(() =>
      toast.danger(`Couldn’t open ${summary.title}`),
    );
  };

  const chip = (
    <InlineReferenceVisual
      as="button"
      type="button"
      contentEditable={false}
      className={canOpen ? "blend cursor-interaction" : "blend"}
      label={label}
      labelClassName="blend"
      aria-label={canOpen ? `Open ${summary.title}` : summary.title}
      icon={
        <AttachmentResourceIcon
          kind={resolvedProps.kind}
          name={resolvedProps.name}
          mimeType={resolvedProps.mimeType}
          className="size-full"
        />
      }
      trailing={resolvedProps.mode === "link" ? <Link2 className="size-full" /> : undefined}
      data-attachment-inline-chip="true"
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (canOpen) open(event.metaKey || event.ctrlKey ? "durable" : "preview");
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (previewsInPlace) return;
        if (destination.kind === "page-file" || destination.kind === "local-path") open("durable");
      }}
      onContextMenu={
        destination.kind === "local-path" || destination.kind === "managed-asset"
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              void openLocalAttachmentMenu(event, destination, summary.title, router);
            }
          : undefined
      }
    />
  );
  const reference =
    destination.kind === "page-file" || destination.kind === "file-viewer" ? (
      <LibraryFileMenu
        chip={chip}
        destination={destination}
        runtime={fileRuntime}
        source={resolvedProps.source}
        name={summary.title}
        open={open}
        onOpenChange={setMenuOpen}
      />
    ) : (
      chip
    );
  const surface = (
    <span className="inline align-baseline">
      <NodexTooltip
        tooltipContent={
          <div className="max-w-[24rem] space-y-0.5 text-left">
            <div className="truncate font-medium text-[var(--foreground)]">{summary.title}</div>
            <div className="truncate text-xs text-[color-mix(in_srgb,var(--foreground)_58%,transparent)]">
              {summary.detail}
            </div>
          </div>
        }
        side="top"
        align="start"
        sideOffset={4}
        delay={0}
        disabled={menuOpen}
        tooltipClassName="px-2 py-1.5"
      >
        <span className="inline align-baseline">{reference}</span>
      </NodexTooltip>
      {imagePreviewOpen && destination.kind === "page-file" ? (
        <PageFileImagePreview
          fileId={destination.fileId}
          name={summary.title}
          onClose={() => setImagePreviewOpen(false)}
          onOpenInTab={() => open("durable")}
        />
      ) : null}
    </span>
  );

  if (!canOpen) return surface;
  return (
    <MentionInlineFocusAffordance
      label={
        destination.kind === "local-path" && destination.directory ? "Open folder" : "Open file"
      }
    >
      {surface}
    </MentionInlineFocusAffordance>
  );
}

export function createAttachmentInlineContentSpec() {
  return createReactInlineContentSpec(attachmentInlineContentConfig, {
    render: ({ inlineContent }) => (
      <AttachmentInlineContent inlineContent={inlineContent as { props: AttachmentProps }} />
    ),
    toExternalHTML: ({ inlineContent }) => {
      const props = (inlineContent as { props: AttachmentProps }).props;
      const label = getAttachmentLabel(props, 80);
      const modeLabel = props.mode === "link" ? "Linked attachment" : "Saved attachment";

      return (
        <InlineReferenceVisual
          label={`${label} (${modeLabel})`}
          icon={
            <AttachmentResourceIcon
              kind={props.kind}
              name={props.name}
              mimeType={props.mimeType}
              className="size-full"
            />
          }
          trailing={props.mode === "link" ? <Link2 className="size-full" /> : undefined}
        />
      );
    },
  });
}
