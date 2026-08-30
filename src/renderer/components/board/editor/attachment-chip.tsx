import { CopyIcon, FolderOpenIcon, OpenExternalIcon } from "@/components/shared/icons";
import { useCallback, useMemo, useState, type ComponentType } from "react";
import { createReactInlineContentSpec } from "@blocknote/react";
import { Link2 } from "@/components/shared/icons/generic-icons";

import { NodexPopover, NodexPopoverTrigger } from "@/components/ui/popover";
import { NodexTooltip } from "@/components/ui/tooltip";
import { resolveManagedAssetPath } from "@/lib/assets";
import { openFileLink } from "@/lib/file-system-operations";
import { useFileReferenceRouter } from "@/lib/file-reference-router";
import { useFileLinkOpener } from "@/lib/use-file-link-opener";
import { attachmentInlineContentConfig } from "../../../../shared/block-documents/blocknote-schema-config";
import { formatAttachmentBytes } from "./attachment-chip-format";
import { AttachmentResourceIcon } from "../attachment-resource-icon";
import { getAttachmentTooltipLines } from "./attachment-chip-tooltip";
import { parsePageFileSource } from "../../../../shared/page-files";
import { usePageFilePlacementRuntime, usePageFileReadSnapshot } from "./page-file-runtime";
import { InlineReferenceVisual } from "../inline-reference-visual";
import {
  isTextLikeMimeType,
  useAttachmentPreview,
  type AttachmentPreviewData,
  type AttachmentPreviewInput,
  type AttachmentPreviewState,
} from "./attachment-preview";
import { NfmEditorPopoverContent } from "./nfm-editor-popover-content";
import { PageFileOwnerDisclosure } from "./page-file-owner-disclosure";

export { isTextLikeMimeType };
export type { AttachmentPreviewState };
export type AttachmentPreview = AttachmentPreviewData;

export interface AttachmentProps extends AttachmentPreviewInput {
  name: string;
  bytes?: number;
  origin?: string;
  ownerPageId?: string;
}

const ATTACHMENT_INLINE_LABEL_LIMIT = 48;

function getAttachmentSizeLabel(props: Pick<AttachmentProps, "kind" | "bytes">): string {
  if (props.kind === "folder") return "";
  return formatAttachmentBytes(props.bytes);
}

export function getAttachmentLabel(
  props: Pick<AttachmentProps, "kind" | "name">,
  maxLength = ATTACHMENT_INLINE_LABEL_LIMIT,
): string {
  const base = props.name.trim();
  const fallback = props.kind === "text" ? "Pasted text" : "Untitled attachment";
  const label = base.length > 0 ? base : fallback;
  return label.length > maxLength ? `${label.slice(0, maxLength).trimEnd()}...` : label;
}

function AttachmentPopover({
  props,
  previewState,
  onPrimaryOpen,
}: {
  props: AttachmentProps;
  previewState: AttachmentPreviewState;
  onPrimaryOpen: () => Promise<void>;
}) {
  const { opener } = useFileLinkOpener();
  const isOwnedFile = parsePageFileSource(props.source) !== null;

  const sizeLabel = getAttachmentSizeLabel(props);
  const stateLabel = isOwnedFile
    ? "Saved in Nodex"
    : props.mode === "materialized"
      ? "Saved in Nodex"
      : "Linked to the original";
  const hasOriginal =
    typeof props.origin === "string" && props.origin.length > 0 && props.origin !== props.source;

  const resolvePrimaryPath = useCallback(async (): Promise<string | null> => {
    if (props.mode === "link") return props.source || null;
    if (isOwnedFile) return null;
    return await resolveManagedAssetPath(props.source);
  }, [isOwnedFile, props.mode, props.source]);

  const openPath = useCallback(
    async (path: string, nextOpener = opener) => {
      await openFileLink({ path }, nextOpener);
    },
    [opener],
  );

  const handleReveal = useCallback(async () => {
    const targetPath = await resolvePrimaryPath();
    if (!targetPath) return;
    await openPath(targetPath, "fileManager");
  }, [openPath, resolvePrimaryPath]);

  const handleCopyPath = useCallback(async () => {
    const targetPath = await resolvePrimaryPath();
    await navigator.clipboard.writeText(targetPath || props.source);
  }, [props.source, resolvePrimaryPath]);

  const handleOpenOriginal = useCallback(async () => {
    if (!props.origin) return;
    await openPath(props.origin);
  }, [openPath, props.origin]);

  return (
    <AttachmentPopoverView
      attachment={props}
      previewState={previewState}
      isOwnedFile={isOwnedFile}
      stateLabel={stateLabel}
      sizeLabel={sizeLabel}
      onPrimaryOpen={onPrimaryOpen}
      onReveal={isOwnedFile ? null : handleReveal}
      onCopyPath={handleCopyPath}
      onOpenOriginal={hasOriginal ? handleOpenOriginal : null}
    />
  );
}

export function AttachmentPopoverView({
  attachment,
  previewState,
  isOwnedFile,
  stateLabel,
  sizeLabel,
  onPrimaryOpen,
  onReveal,
  onCopyPath,
  onOpenOriginal,
}: {
  readonly attachment: AttachmentProps;
  readonly previewState: AttachmentPreviewState;
  readonly isOwnedFile: boolean;
  readonly stateLabel: string;
  readonly sizeLabel: string;
  readonly onPrimaryOpen: () => Promise<void>;
  readonly onReveal: (() => Promise<void>) | null;
  readonly onCopyPath: () => Promise<void>;
  readonly onOpenOriginal: (() => Promise<void>) | null;
}) {
  const hasOriginal =
    typeof attachment.origin === "string" &&
    attachment.origin.length > 0 &&
    attachment.origin !== attachment.source;

  return (
    <div className="w-[min(32rem,calc(100vw-2rem))] p-2 text-sm">
      <header className="flex min-w-0 items-center gap-2.5 px-1 pt-0.5">
        <AttachmentResourceIcon
          kind={attachment.kind}
          name={attachment.name}
          mimeType={attachment.mimeType}
          className="size-5 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-token-text-primary">
            {attachment.name || "Untitled attachment"}
          </div>
          <div className="mt-0.5 text-xs text-token-description-foreground">
            {attachment.kind}
            {sizeLabel ? ` · ${sizeLabel}` : ""} · {stateLabel}
          </div>
        </div>
      </header>

      <PageFileOwnerDisclosure ownerPageId={attachment.ownerPageId} className="mt-2 px-1" />

      <dl className="mt-3 grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 border-t-[0.5px] border-token-border px-1 pt-3 text-xs">
        <dt className="text-token-description-foreground">Source</dt>
        <dd className="truncate font-mono text-token-text-secondary">{attachment.source}</dd>
        {hasOriginal ? (
          <>
            <dt className="text-token-description-foreground">Original</dt>
            <dd className="truncate font-mono text-token-text-secondary">{attachment.origin}</dd>
          </>
        ) : null}
      </dl>

      <div className="mt-3 flex flex-wrap gap-1.5 px-1">
        <AttachmentActionButton
          label={isOwnedFile ? "Save" : "Open"}
          icon={OpenExternalIcon}
          onClick={onPrimaryOpen}
        />
        {onReveal ? (
          <AttachmentActionButton label="Reveal" icon={FolderOpenIcon} onClick={onReveal} />
        ) : null}
        <AttachmentActionButton
          label={isOwnedFile ? "Copy reference" : "Copy path"}
          icon={CopyIcon}
          onClick={onCopyPath}
        />
        {onOpenOriginal ? (
          <AttachmentActionButton label="Open original" icon={Link2} onClick={onOpenOriginal} />
        ) : null}
      </div>

      {previewState.status !== "unavailable" ? (
        <div className="mt-3 overflow-hidden rounded-lg bg-transparent ring-[0.5px] ring-inset ring-token-border">
          {previewState.status === "loading" ? (
            <div className="px-3 py-2 text-xs text-token-description-foreground">
              Loading preview...
            </div>
          ) : null}

          {previewState.status === "failed" ? (
            <div className="px-3 py-2 text-xs text-token-description-foreground">
              Preview unavailable.
            </div>
          ) : null}

          {previewState.status === "ready" && previewState.preview.type === "text" ? (
            <div className="px-3 py-2">
              <pre className="scrollbar-token max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-token-text-primary">
                {previewState.preview.content}
              </pre>
              {previewState.preview.truncated ? (
                <p className="mt-2 text-[11px] text-token-description-foreground">
                  Preview limited to 200 lines or 64 KiB.
                </p>
              ) : null}
            </div>
          ) : null}

          {previewState.status === "ready" && previewState.preview.type === "folder" ? (
            <div className="px-3 py-2">
              <div className="max-h-64 space-y-1 overflow-auto font-mono text-[12px] leading-5 text-token-text-secondary">
                {previewState.preview.manifest.entries.map((entry) => (
                  <div key={`${entry.kind}:${entry.path}`} className="truncate">
                    {entry.kind === "folder" ? "📁" : "·"} {entry.path}
                    {entry.kind === "file" && typeof entry.bytes === "number"
                      ? ` (${formatAttachmentBytes(entry.bytes)})`
                      : ""}
                  </div>
                ))}
              </div>
              {previewState.preview.manifest.truncated ? (
                <p className="mt-2 text-[11px] text-token-description-foreground">
                  Snapshot limited to {previewState.preview.manifest.maxEntries} entries and{" "}
                  {previewState.preview.manifest.maxDepth} levels.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {previewState.status === "unavailable" && attachment.mode === "link" ? (
        <p className="mt-3 px-1 text-xs text-token-description-foreground">
          This attachment keeps a link to the original location instead of copying its contents into
          Nodex.
        </p>
      ) : null}

      {previewState.status === "unavailable" && attachment.mode === "materialized" ? (
        <p className="mt-3 px-1 text-xs text-token-description-foreground">
          This saved attachment doesn&apos;t have an inline preview.
        </p>
      ) : null}
    </div>
  );
}

function AttachmentActionButton({
  label,
  icon: Icon,
  onClick,
}: {
  label: string;
  icon: ComponentType<{ className?: string }>;
  onClick: () => Promise<void>;
}) {
  return (
    <button
      type="button"
      className="inline-flex h-7 items-center gap-1.5 rounded-md bg-transparent px-2 text-xs text-token-text-secondary ring-[0.5px] ring-inset ring-token-border hover:bg-token-foreground/5 hover:text-token-text-primary focus-visible:ring-2 focus-visible:ring-token-focus"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void onClick();
      }}
    >
      <Icon className="size-3.5" />
      <span>{label}</span>
    </button>
  );
}

function AttachmentInlineContent({ inlineContent }: { inlineContent: { props: AttachmentProps } }) {
  const [open, setOpen] = useState(false);
  const fileReferenceRouter = useFileReferenceRouter();
  const pageFileRuntime = usePageFilePlacementRuntime();
  const isOwnedFile = parsePageFileSource(inlineContent.props.source) !== null;
  const metadataSnapshot = usePageFileReadSnapshot(pageFileRuntime, inlineContent.props.source, {
    metadata: isOwnedFile,
  });
  const ownedMetadata = metadataSnapshot.metadata;
  const resolvedProps = useMemo<AttachmentProps>(() => {
    if (!ownedMetadata) return inlineContent.props;
    return {
      ...inlineContent.props,
      name: ownedMetadata.logicalPath.split("/").at(-1) || inlineContent.props.name,
      mimeType: ownedMetadata.mimeType,
      bytes: ownedMetadata.byteLength,
      ownerPageId: ownedMetadata.ownerPageId,
    };
  }, [inlineContent.props, ownedMetadata]);
  const label = useMemo(() => getAttachmentLabel(resolvedProps), [resolvedProps]);
  const tooltipLines = getAttachmentTooltipLines(resolvedProps);

  const resolvePrimaryPath = useCallback(async (): Promise<string | null> => {
    if (inlineContent.props.mode === "link") return inlineContent.props.source || null;
    if (isOwnedFile) return null;
    return await resolveManagedAssetPath(inlineContent.props.source);
  }, [inlineContent.props.mode, inlineContent.props.source, isOwnedFile]);

  const handlePrimaryOpen = useCallback(async () => {
    if (isOwnedFile) {
      if (!pageFileRuntime) return;
      await pageFileRuntime.save(resolvedProps.source, resolvedProps.name || "File");
      return;
    }
    const path = await resolvePrimaryPath();
    if (!path) return;
    await fileReferenceRouter.open({ path }, { title: label });
  }, [fileReferenceRouter, isOwnedFile, label, pageFileRuntime, resolvePrimaryPath, resolvedProps]);
  const attachmentPreview = useAttachmentPreview(resolvedProps, pageFileRuntime, open);
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) attachmentPreview.preload();
    setOpen(nextOpen);
  };

  return (
    <NodexPopover open={open} onOpenChange={handleOpenChange}>
      <NodexTooltip
        tooltipContent={
          <div className="space-y-0.5">
            <div className="font-medium text-[var(--foreground)]">{tooltipLines.primary}</div>
            <div className="text-xs text-[color-mix(in_srgb,var(--foreground)_58%,transparent)]">
              {tooltipLines.secondary}
            </div>
          </div>
        }
        side="top"
        delay={0}
        disabled={open}
      >
        <span className="inline align-baseline">
          <NodexPopoverTrigger>
            <InlineReferenceVisual
              as="button"
              type="button"
              contentEditable={false}
              className="blend cursor-interaction"
              label={label}
              labelClassName="blend"
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
              onPointerEnter={attachmentPreview.preload}
              onFocus={attachmentPreview.preload}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            />
          </NodexPopoverTrigger>
        </span>
      </NodexTooltip>

      <NfmEditorPopoverContent side="top" align="start" className="w-auto">
        <AttachmentPopover
          props={resolvedProps}
          previewState={attachmentPreview.state}
          onPrimaryOpen={handlePrimaryOpen}
        />
      </NfmEditorPopoverContent>
    </NodexPopover>
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
